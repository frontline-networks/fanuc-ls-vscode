/**
 * Lokale FANUC-Dokumentation durchsuchen (#13): Abschnitte bilden, suchen, Auszüge.
 * Ohne VS-Code-Abhängigkeit, damit testbar. Die Handbücher selbst liefert der
 * Anwender (Ordner in fanucLs.docs.folder), sie werden nicht mit ausgeliefert.
 */

export interface DocChunk {
	/** absoluter Dateipfad */
	file: string;
	/** Seite (PDF, ab 1) bzw. Abschnittsnummer (Text) */
	page: number;
	/** Überschrift des Abschnitts (Text/Markdown) bzw. erste Zeile der Seite */
	title: string;
	/** erste Zeile des Abschnitts in der Quelldatei (nur Text/Markdown, ab 0) */
	line?: number;
	text: string;
}

export interface SearchHit {
	chunk: DocChunk;
	score: number;
	snippet: string;
}

/** Text vergleichbar machen: klein, Umlaute ausgeschrieben, Silbentrennung am Zeilenende entfernt. */
export function normalize(s: string): string {
	return s
		.toLowerCase()
		.replace(/ä/g, 'ae')
		.replace(/ö/g, 'oe')
		.replace(/ü/g, 'ue')
		.replace(/ß/g, 'ss');
}

const STOPWORDS = new Set([
	'der', 'die', 'das', 'und', 'oder', 'ein', 'eine', 'einen', 'mit', 'fuer', 'von', 'zu', 'im', 'in', 'ist', 'wie', 'was',
	'the', 'a', 'an', 'of', 'to', 'and', 'or', 'is', 'for', 'on', 'how', 'what'
]);

/** Suchbegriffe: Wörter und Codes wie FILE-097 oder PR[1] bleiben zusammen. */
export function terms(query: string): string[] {
	const out: string[] = [];
	for (const m of normalize(query).matchAll(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g)) {
		const t = m[0];
		if (t.length > 1 && !STOPWORDS.has(t)) {
			out.push(t);
		}
	}
	return [...new Set(out)];
}

/** Text- und Markdown-Dateien in Abschnitte teilen: an Überschriften, sonst alle ~40 Zeilen. */
export function chunkText(file: string, text: string, maxLines = 40): DocChunk[] {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const chunks: DocChunk[] = [];
	let start = 0;
	let title = '';
	const flush = (end: number) => {
		const body = lines.slice(start, end).join('\n').trim();
		if (body) {
			chunks.push({ file, page: chunks.length + 1, title: title || firstLine(body), line: start, text: body });
		}
	};
	for (let i = 0; i < lines.length; i++) {
		const heading = /^#{1,4}\s+(.+)$/.exec(lines[i]);
		if ((heading && i > start) || i - start >= maxLines) {
			flush(i);
			start = i;
			title = '';
		}
		if (heading) {
			title = heading[1].trim();
		}
	}
	flush(lines.length);
	return chunks;
}

/** PDF-Seiten als Abschnitte (Text je Seite). */
export function chunkPages(file: string, pages: string[]): DocChunk[] {
	return pages
		.map((text, i) => ({ file, page: i + 1, title: firstLine(text), text: text.trim() }))
		.filter((c) => c.text.length > 0);
}

function firstLine(s: string): string {
	return (s.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 80);
}

function count(hay: string, needle: string): number {
	let n = 0;
	let i = hay.indexOf(needle);
	while (i >= 0) {
		n++;
		i = hay.indexOf(needle, i + needle.length);
	}
	return n;
}

/**
 * Suche mit einfacher Gewichtung: seltene Begriffe zählen mehr, Treffer in der
 * Überschrift und die ganze Wortfolge geben einen Bonus. Alle Begriffe müssen vorkommen,
 * sonst werden Abschnitte mit den meisten Begriffen geliefert.
 */
export function search(chunks: DocChunk[], query: string, limit = 20): SearchHit[] {
	const ts = terms(query);
	if (ts.length === 0) {
		return [];
	}
	const phrase = normalize(query).replace(/\s+/g, ' ').trim();
	const norm = chunks.map((c) => ({ c, body: normalize(c.text), head: normalize(c.title) }));
	const df = new Map(ts.map((t) => [t, norm.filter((n) => n.body.includes(t)).length]));
	const scored = norm
		.map(({ c, body, head }) => {
			let score = 0;
			let matched = 0;
			for (const t of ts) {
				const tf = count(body, t);
				if (tf === 0) {
					continue;
				}
				matched++;
				const idf = Math.log(1 + chunks.length / (df.get(t) ?? 1));
				score += idf * (1 + Math.log(tf)) + (head.includes(t) ? idf : 0);
			}
			if (ts.length > 1 && phrase.length > 3 && body.includes(phrase)) {
				score *= 2;
			}
			return { c, body, score: score * (matched / ts.length) ** 2, matched };
		})
		.filter((x) => x.matched > 0);
	const best = Math.max(0, ...scored.map((x) => x.matched));
	return scored
		.filter((x) => x.matched === best)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((x) => ({ chunk: x.c, score: x.score, snippet: snippet(x.c.text, ts, phrase) }));
}

/** Kurzer Auszug um die erste Fundstelle. */
export function snippet(text: string, ts: string[], phrase = '', radius = 110): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	const n = normalize(flat);
	let at = phrase ? n.indexOf(phrase) : -1;
	for (const t of ts) {
		if (at >= 0) {
			break;
		}
		at = n.indexOf(t);
	}
	at = Math.max(0, at);
	const from = Math.max(0, at - radius);
	const to = Math.min(flat.length, at + radius);
	return (from > 0 ? '… ' : '') + flat.slice(from, to).trim() + (to < flat.length ? ' …' : '');
}

/** Zeile im Abschnitt mit den meisten Suchbegriffen (für das Springen im Editor). */
export function matchLine(text: string, query: string): number {
	const ts = terms(query);
	let best = 0;
	let bestCount = 0;
	text.split('\n').forEach((l, i) => {
		const n = normalize(l);
		const c = ts.filter((t) => n.includes(t)).length;
		if (c > bestCount) {
			best = i;
			bestCount = c;
		}
	});
	return best;
}
