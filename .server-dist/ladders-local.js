"use strict";Object.defineProperty(exports, "__esModule", {value: true});/**
 * Ladder library
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * This file handles ladders for all servers other than
 * play.pokemonshowdown.com.
 *
 * Specifically, this is the file that handles calculating and keeping
 * track of players' Elo ratings for all formats.
 *
 * Matchmaking is currently still implemented in rooms.js.
 *
 * @license MIT license
 */

'use strict';

var _fs = require('../.lib-dist/fs');

// ladderCaches = {formatid: ladder OR Promise(ladder)}
// Use Ladders(formatid).ladder to guarantee a Promise(ladder).
// ladder is basically a 2D array representing the corresponding ladder.tsv
//   with userid in front
/** [userid, elo, username, w, l, t, lastUpdate */




const ladderCaches = new Map();

 class LadderStore {
	
	
	
	
	static __initStatic() {this.formatsListPrefix = '|,LL'}
	static __initStatic2() {this.ladderCaches = ladderCaches}

	constructor(formatid) {
		this.formatid = formatid;
		this.ladder = null;
		this.ladderPromise = null;
		this.saving = false;
	}

	getLadder() {
		if (!this.ladderPromise) this.ladderPromise = this.load();
		return this.ladderPromise;
	}

	/**
	 * Internal function, returns a Promise for a ladder
	 */
	async load() {
		// ladderCaches[formatid]
		const cachedLadder = ladderCaches.get(this.formatid);
		if (cachedLadder) {
			// @ts-ignore
			if (cachedLadder.then) {
				const ladder = await cachedLadder;
				return (this.ladder = ladder);
			}
			// @ts-ignore
			return (this.ladder = cachedLadder);
		}
		try {
			const data = await _fs.FS.call(void 0, 'config/ladders/' + this.formatid + '.tsv').readIfExists();
			const ladder = [];
			for (const dataLine of data.split('\n')) {
				const line = dataLine.trim();
				if (!line) continue;
				const row = line.split('\t');
				ladder.push([toID(row[1]), Number(row[0]), row[1], Number(row[2]), Number(row[3]), Number(row[4]), row[5]]);
			}
			// console.log('Ladders(' + this.formatid + ') loaded tsv: ' + JSON.stringify(this.ladder));
			ladderCaches.set(this.formatid, (this.ladder = ladder));
			return this.ladder;
		} catch (err) {
			// console.log('Ladders(' + this.formatid + ') err loading tsv: ' + JSON.stringify(this.ladder));
		}
		ladderCaches.set(this.formatid, (this.ladder = []));
		return this.ladder;
	}

	/**
	 * Saves the ladder in config/ladders/[formatid].tsv
	 *
	 * Called automatically by updateRating, so you don't need to manually
	 * call this.
	 */
	async save() {
		if (this.saving) return;
		this.saving = true;
		const ladder = await this.getLadder();
		if (!ladder.length) {
			this.saving = false;
			return;
		}
		const stream = _fs.FS.call(void 0, `config/ladders/${this.formatid}.tsv`).createWriteStream();
		stream.write('Elo\tUsername\tW\tL\tT\tLast update\r\n');
		for (const row of ladder) {
			stream.write(row.slice(1).join('\t') + '\r\n');
		}
		// tslint:disable-next-line no-floating-promises
		stream.end();
		this.saving = false;
	}

	/**
	 * Gets the index of a user in the ladder array.
	 *
	 * If createIfNeeded is true, the user will be created and added to
	 * the ladder array if it doesn't already exist.
	 */
	indexOfUser(username, createIfNeeded = false) {
		if (!this.ladder) throw new Error(`Must be called with ladder loaded`);
		const userid = toID(username);
		for (const [i, user] of this.ladder.entries()) {
			if (user[0] === userid) return i;
		}
		if (createIfNeeded) {
			const index = this.ladder.length;
			this.ladder.push([userid, 1000, username, 0, 0, 0, '']);
			return index;
		}
		return -1;
	}

	/**
	 * Returns [formatid, html], where html is an the HTML source of a
	 * ladder toplist, to be displayed directly in the ladder tab of the
	 * client.
	 */
	async getTop(prefix) {
		const formatid = this.formatid;
		const name = Dex.getFormat(formatid).name;
		const ladder = await this.getLadder();
		let buf = `<h3>${name} Top 100</h3>`;
		buf += `<table>`;
		buf += `<tr><th>` + ['', 'Username', '<abbr title="Elo rating">Elo</abbr>', 'W', 'L', 'T'].join(`</th><th>`) + `</th></tr>`;
		for (const [i, row] of ladder.entries()) {
			if (prefix && !row[0].startsWith(prefix)) continue;
			buf += `<tr><td>` + [
				i + 1, row[2], `<strong>${Math.round(row[1])}</strong>`, row[3], row[4], row[5],
			].join(`</td><td>`) + `</td></tr>`;
		}
		return [formatid, buf];
	}

	/**
	 * Returns a Promise for the Elo rating of a user
	 */
	async getRating(userid) {
		const formatid = this.formatid;
		const user = Users.getExact(userid);
		if (user && user.mmrCache[formatid]) {
			return user.mmrCache[formatid];
		}
		const ladder = await this.getLadder();
		const index = this.indexOfUser(userid);
		let rating = 1000;
		if (index >= 0) {
			rating = ladder[index][1];
		}
		if (user && user.userid === userid) {
			user.mmrCache[formatid] = rating;
		}
		return rating;
	}

	/**
	 * Internal method. Update the Elo rating of a user.
	 */
	updateRow(row, score, foeElo) {
		let elo = row[1];

		// The K factor determines how much your Elo changes when you win or
		// lose games. Larger K means more change.
		// In the "original" Elo, K is constant, but it's common for K to
		// get smaller as your rating goes up
		let K = 50;

		// dynamic K-scaling (optional)
		if (elo < 1200) {
			if (score < 0.5) {
				K = 10 + (elo - 1000) * 40 / 200;
			} else if (score > 0.5) {
				K = 90 - (elo - 1000) * 40 / 200;
			}
		} else if (elo > 1350 && elo <= 1600) {
			K = 40;
		} else {
			K = 32;
		}

		// main Elo formula
		const E = 1 / (1 + Math.pow(10, (foeElo - elo) / 400));
		elo += K * (score - E);

		if (elo < 1000) elo = 1000;

		row[1] = elo;
		if (score > 0.6) {
			row[3]++; // win
		} else if (score < 0.4) {
			row[4]++; // loss
		} else {
			row[5]++; // tie
		}
		row[6] = '' + new Date();
	}

	/**
	 * Update the Elo rating for two players after a battle, and display
	 * the results in the passed room.
	 */
	async updateRating(p1name, p2name, p1score, room) {
		if (Ladders.disabled) {
			room.addRaw(`Ratings not updated. The ladders are currently disabled.`).update();
			return [p1score, null, null];
		}

		const formatid = this.formatid;
		let p2score = 1 - p1score;
		if (p1score < 0) {
			p1score = 0;
			p2score = 0;
		}
		const ladder = await this.getLadder();

		let p1newElo;
		let p2newElo;
		try {
			const p1index = this.indexOfUser(p1name, true);
			const p1elo = ladder[p1index][1];

			let p2index = this.indexOfUser(p2name, true);
			const p2elo = ladder[p2index][1];

			this.updateRow(ladder[p1index], p1score, p2elo);
			this.updateRow(ladder[p2index], p2score, p1elo);

			p1newElo = ladder[p1index][1];
			p2newElo = ladder[p2index][1];

			// console.log('L: ' + ladder.map(r => ''+Math.round(r[1])+' '+r[2]).join('\n'));

			// move p1 to its new location
			let newIndex = p1index;
			while (newIndex > 0 && ladder[newIndex - 1][1] <= p1newElo) newIndex--;
			while (newIndex === p1index || (ladder[newIndex] && ladder[newIndex][1] > p1newElo)) newIndex++;
			// console.log('ni='+newIndex+', p1i='+p1index);
			if (newIndex !== p1index && newIndex !== p1index + 1) {
				const row = ladder.splice(p1index, 1)[0];
				// adjust for removed row
				if (newIndex > p1index) newIndex--;
				if (p2index > p1index) p2index--;

				ladder.splice(newIndex, 0, row);
				// adjust for inserted row
				if (p2index >= newIndex) p2index++;
			}

			// move p2
			newIndex = p2index;
			while (newIndex > 0 && ladder[newIndex - 1][1] <= p2newElo) newIndex--;
			while (newIndex === p2index || (ladder[newIndex] && ladder[newIndex][1] > p2newElo)) newIndex++;
			// console.log('ni='+newIndex+', p2i='+p2index);
			if (newIndex !== p2index && newIndex !== p2index + 1) {
				const row = ladder.splice(p2index, 1)[0];
				// adjust for removed row
				if (newIndex > p2index) newIndex--;

				ladder.splice(newIndex, 0, row);
			}

			const p1 = Users.getExact(p1name);
			if (p1) p1.mmrCache[formatid] = +p1newElo;
			const p2 = Users.getExact(p2name);
			if (p2) p2.mmrCache[formatid] = +p2newElo;
			// tslint:disable-next-line no-floating-promises
			this.save();

			if (!room.battle) {
				Monitor.warn(`room expired before ladder update was received`);
				return [p1score, null, null];
			}

			let reasons = '' + (Math.round(p1newElo) - Math.round(p1elo)) + ' for ' + (p1score > 0.9 ? 'winning' : (p1score < 0.1 ? 'losing' : 'tying'));
			if (reasons.charAt(0) !== '-') reasons = '+' + reasons;
			room.addRaw(
				Chat.html`${p1name}'s rating: ${Math.round(p1elo)} &rarr; <strong>${Math.round(p1newElo)}</strong><br />(${reasons})`
			);

			reasons = '' + (Math.round(p2newElo) - Math.round(p2elo)) + ' for ' + (p2score > 0.9 ? 'winning' : (p2score < 0.1 ? 'losing' : 'tying'));
			if (reasons.charAt(0) !== '-') reasons = '+' + reasons;
			room.addRaw(
				Chat.html`${p2name}'s rating: ${Math.round(p2elo)} &rarr; <strong>${Math.round(p2newElo)}</strong><br />(${reasons})`
			);

			room.update();
		} catch (e) {
			if (!room.battle) return [p1score, null, null];
			room.addRaw(`There was an error calculating rating changes:`);
			room.add(e.stack);
			room.update();
		}

		return [p1score, p1newElo, p2newElo];
	}

	/**
	 * Returns a promise for a <tr> with all ratings for the current format.
	 */
	async visualize(username) {
		const ladder = await this.getLadder();

		const index = this.indexOfUser(username, false);

		if (index < 0) return '';

		const ratings = ladder[index];

		const output = `<tr><td>${this.formatid}</td><td><strong>${Math.round(ratings[1])}</strong></td>`;
		return `${output}<td>${ratings[3]}</td><td>${ratings[4]}</td><td>${ratings[3] + ratings[4]}</td></tr>`;
	}

	/**
	 * Returns a Promise for an array of strings of <tr>s for ladder ratings of the user
	 */
	static visualizeAll(username) {
		const ratings = [];
		for (const i in Dex.formats) {
			if (Dex.formats[i].searchShow) {
				ratings.push(new LadderStore(i).visualize(username));
			}
		}
		return Promise.all(ratings);
	}
} LadderStore.__initStatic(); LadderStore.__initStatic2(); exports.LadderStore = LadderStore;
