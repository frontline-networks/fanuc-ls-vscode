/**
 * FANUC DIOCFGSV.IO lesen und schreiben: E/A-Kommentare aus einer Signal-Excel
 * (z. B. "Fanuc IO-Mapping") in die E/A-Konfiguration übernehmen.
 *
 * Portierung von diocfg_converter.py. Zuordnungen (ASG_*), MODE_*, AIS_* und DEV_*
 * bleiben unverändert aus der Vorlage (Backup des Zielroboters); nur die
 * Kommentartabellen (NAME_*) werden neu aufgebaut. Ohne VS-Code-Abhängigkeit, damit testbar.
 *
 * Dateiaufbau: Kopf bis zum ersten 0xFC, danach Variablen:
 *   0xFC, Name\0, Typ1, Typ2, 0x00, Nutzdaten
 *   Skalar (Typ1 = 0x00): 4 Byte Wert (big-endian)
 *   Feld: Anzahl (u16), Elementgröße (u16), Elemente, auf 4 Byte aufgefüllt
 *   Textfeld (Typ1 = 0x3F): je Element [max. Länge, Länge, Zeichen …]
 */
import { Sheet, Workbook } from './excelReader';

export const PORT_TYPES: Record<string, number> = {
	DI: 1, DO: 2, AI: 3, AO: 4, WI: 16, WO: 17,
	SI: 11, SO: 12, GI: 18, GO: 19, UI: 20, UO: 21,
	WSI: 26, WSO: 27
};
export const PORT_NAMES: Record<number, string> = Object.fromEntries(Object.entries(PORT_TYPES).map(([k, v]) => [v, k]));

export const NAME1_LEN = 16;
export const NAME2_LEN = 8;
export const MAX_COMMENT = NAME1_LEN + NAME2_LEN;
/** Blätter der Vorlage "Fanuc IO-Mapping" */
export const XLS_SHEETS = ['PlcToRob', 'RobToPlc', 'GI', 'GO'];

const TYPE_SCALAR = 0x00;
const TYPE_STRING = 0x3f;

interface DioRecord {
	name: string;
	t1: number;
	t2: number;
	/** Originalbytes ab 0xFC bis zum nächsten Datensatz */
	raw: Buffer;
	value: number | (number | string)[];
	elemSize?: number;
}

export interface Assignment {
	type: number;
	start: number;
	count: number;
	rack: number;
	slot: number;
	phyType: number;
	phyStart: number;
}

/** Schlüssel "Typnummer:Nummer", z. B. "2:12" für DO[12] */
export type CommentKey = string;
export const key = (type: number, no: number): CommentKey => `${type}:${no}`;
export const unkey = (k: CommentKey): [number, number] => k.split(':').map(Number) as [number, number];

export class DioCfg {
	private constructor(readonly header: Buffer, readonly records: Map<string, DioRecord>) {}

	static parse(b: Buffer): DioCfg {
		const first = b.indexOf(0xfc);
		if (first < 0 || !b.subarray(0, first).includes('DIO')) {
			throw new Error('Keine DIOCFGSV.IO-Datei (E/A-Konfiguration einer FANUC-Steuerung).');
		}
		const records = new Map<string, DioRecord>();
		let pos = first;
		while (pos < b.length) {
			if (b[pos] !== 0xfc) {
				throw new Error(`Formatfehler an Position ${pos}.`);
			}
			const end = b.indexOf(0, pos + 1);
			if (end < 0) {
				throw new Error(`Formatfehler an Position ${pos}.`);
			}
			const name = b.toString('latin1', pos + 1, end);
			let p = end + 1;
			const t1 = b[p];
			const t2 = b[p + 1];
			let value: DioRecord['value'];
			let elemSize: number | undefined;
			if (t1 === TYPE_SCALAR) {
				value = b.readUInt32BE(p + 3);
				p += 7;
			} else {
				const n = b.readUInt16BE(p + 3);
				const size = b.readUInt16BE(p + 5);
				elemSize = size;
				p += 7;
				const data = b.subarray(p, p + n * size);
				p += n * size;
				p += (4 - ((n * size) % 4)) % 4;
				const items: (number | string)[] = [];
				for (let k = 0; k < n; k++) {
					const e = data.subarray(k * size, (k + 1) * size);
					if (t1 === TYPE_STRING) {
						items.push(e.toString('latin1', 2, 2 + e[1]));
					} else {
						let v = 0;
						for (const byte of e) {
							v = v * 256 + byte;
						}
						items.push(v);
					}
				}
				value = items;
			}
			p = Math.min(p, b.length);
			records.set(name, { name, t1, t2, raw: b.subarray(pos, p), value, elemSize });
			pos = p;
		}
		for (const r of ['NAME_LOG_PT', 'NAME_LOG_PN', 'NAME_NAME', 'NAME_NAME2']) {
			if (!Array.isArray(records.get(r)?.value)) {
				throw new Error(`DIOCFGSV.IO ohne Kommentartabelle ${r}.`);
			}
		}
		return new DioCfg(Buffer.from(b.subarray(0, first)), records);
	}

	get version(): number | undefined {
		const v = this.records.get('$$VERSION')?.value;
		return typeof v === 'number' ? v : undefined;
	}

	private arr(name: string): (number | string)[] {
		const v = this.records.get(name)?.value;
		return Array.isArray(v) ? v : [];
	}

	comments(): Map<CommentKey, string> {
		const pt = this.arr('NAME_LOG_PT');
		const pn = this.arr('NAME_LOG_PN');
		const n1 = this.arr('NAME_NAME');
		const n2 = this.arr('NAME_NAME2');
		const out = new Map<CommentKey, string>();
		pt.forEach((t, i) => out.set(key(Number(t), Number(pn[i])), String(n1[i] ?? '') + String(n2[i] ?? '')));
		return out;
	}

	setComments(comments: Map<CommentKey, string>): void {
		const pts: number[] = [];
		const pns: number[] = [];
		const n1: string[] = [];
		const n2: string[] = [];
		for (const [k, text] of comments) {
			const [t, n] = unkey(k);
			pts.push(t);
			pns.push(n);
			n1.push(text.slice(0, NAME1_LEN));
			n2.push(text.slice(NAME1_LEN, MAX_COMMENT));
		}
		this.records.get('NAME_LOG_PT')!.value = pts;
		this.records.get('NAME_LOG_PN')!.value = pns;
		this.records.get('NAME_NAME')!.value = n1;
		this.records.get('NAME_NAME2')!.value = n2;
	}

	assignments(): Assignment[] {
		const cols = ['ASG_LOG_PT', 'ASG_LOG_PN', 'ASG_N_PTS', 'ASG_RACK_NO', 'ASG_SLOT_NO', 'ASG_PHY_PT', 'ASG_PHY_PN'].map((c) => this.arr(c));
		return cols[0].map((_, i) => ({
			type: Number(cols[0][i]),
			start: Number(cols[1][i]),
			count: Number(cols[2][i]),
			rack: Number(cols[3][i]),
			slot: Number(cols[4][i]),
			phyType: Number(cols[5][i]),
			phyStart: Number(cols[6][i])
		}));
	}

	encode(): Buffer {
		const parts: Buffer[] = [this.header];
		for (const r of this.records.values()) {
			parts.push(encodeRecord(r));
		}
		return Buffer.concat(parts);
	}
}

function encodeRecord(r: DioRecord): Buffer {
	if (r.t1 === TYPE_SCALAR || !Array.isArray(r.value) || r.elemSize === undefined) {
		return r.raw;
	}
	const size = r.elemSize;
	const n = r.value.length;
	const head = Buffer.concat([Buffer.from([0xfc]), Buffer.from(r.name, 'latin1'), Buffer.from([0, r.t1, r.t2, 0])]);
	const counts = Buffer.alloc(4);
	counts.writeUInt16BE(n, 0);
	counts.writeUInt16BE(size, 2);
	const data = Buffer.alloc(n * size + ((4 - ((n * size) % 4)) % 4));
	r.value.forEach((v, k) => {
		const off = k * size;
		if (r.t1 === TYPE_STRING) {
			const bytes = Buffer.from(String(v), 'latin1').subarray(0, r.t2);
			data[off] = r.t2;
			data[off + 1] = bytes.length;
			bytes.copy(data, off + 2);
		} else {
			let x = Number(v);
			for (let i = size - 1; i >= 0; i--) {
				data[off + i] = x % 256;
				x = Math.floor(x / 256);
			}
		}
	});
	return Buffer.concat([head, counts, data]);
}

// --- Kommentarquellen ------------------------------------------------------------------------

const TRANSLIT: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss', '°': 'deg', µ: 'u' };

/** Wie im Skript: trimmen, Umlaute umschreiben, andere Sonderzeichen durch "?" ersetzen. */
export function cleanComment(text: string): string {
	return [...(text ?? '').trim()]
		.map((c) => TRANSLIT[c] ?? c)
		.join('')
		.replace(/[^\x20-\x7e]/g, '?');
}

export interface SourceItem {
	type: number;
	no: number;
	text: string;
	source: string;
}

export interface SourceReport {
	items: SourceItem[];
	/** je Blatt bzw. Datei: Anzahl Zeilen oder Grund für das Überspringen */
	notes: { source: string; type?: string; rows?: number; skipped?: string }[];
}

/**
 * Tabelle, deren erste Kopfzelle der Signaltyp ist (DI, DO, GI, …), mit einer
 * Kommentarspalte (Standard "Signal Name", Groß-/Kleinschreibung und Leerzeichen egal).
 */
export function readTableRows(rows: Sheet, source: string, commentColumn: string): SourceReport {
	const report: SourceReport = { items: [], notes: [] };
	if (!rows.length) {
		report.notes.push({ source, skipped: 'leer' });
		return report;
	}
	const header = rows[0].map((h) => String(h ?? '').trim());
	const ptype = (header[0] ?? '').toUpperCase();
	if (!(ptype in PORT_TYPES)) {
		report.notes.push({
			source,
			skipped: ptype === 'F' ? 'Flag-Kommentare werden nicht in DIOCFGSV.IO gespeichert' : `unbekannter Signaltyp „${header[0] ?? ''}“`
		});
		return report;
	}
	const norm = (s: string) => s.toLowerCase().replace(/ /g, '');
	const ci = header.map(norm).indexOf(norm(commentColumn));
	if (ci < 0) {
		report.notes.push({ source, type: ptype, skipped: `Spalte „${commentColumn}“ nicht gefunden` });
		return report;
	}
	for (const row of rows.slice(1)) {
		const first = String(row[0] ?? '').trim();
		if (!first) {
			continue;
		}
		const num = Number(first);
		if (!Number.isFinite(num)) {
			continue;
		}
		report.items.push({ type: PORT_TYPES[ptype], no: Math.trunc(num), text: String(row[ci] ?? ''), source });
	}
	report.notes.push({ source, type: ptype, rows: report.items.length });
	return report;
}

/** Signal-Excel lesen: Standardblätter PlcToRob, RobToPlc, GI, GO, sonst alle Blätter mit Signaltyp. */
export function readSignalWorkbook(wb: Workbook, commentColumn = 'Signal Name', sheets?: string[]): SourceReport {
	const report: SourceReport = { items: [], notes: [] };
	const names = sheets ?? (XLS_SHEETS.some((s) => wb.has(s)) ? XLS_SHEETS : [...wb.keys()]);
	for (const name of names) {
		const sheet = wb.get(name);
		if (!sheet) {
			report.notes.push({ source: name, skipped: 'Blatt nicht gefunden' });
			continue;
		}
		const r = readTableRows(sheet, name, commentColumn);
		report.items.push(...r.items);
		report.notes.push(...r.notes);
	}
	return report;
}

// --- Zusammenführen ---------------------------------------------------------------------------

export interface BuildOptions {
	/** Kommentare der Typen aus der Quelle vorher löschen (sonst zusammenführen) */
	replace?: boolean;
	/** nur diese Typen übernehmen (Typnummern); Standard: alle aus der Quelle */
	types?: number[];
}

export interface Change {
	type: number;
	no: number;
	before?: string;
	after?: string;
}

export interface BuildResult {
	output: Buffer;
	comments: Map<CommentKey, string>;
	added: Change[];
	changed: Change[];
	removed: Change[];
	truncated: { type: number; no: number; text: string }[];
	/** Anzahl Kommentare je Typ im Ergebnis */
	perType: Map<number, number>;
}

export function buildDioCfg(template: Buffer, items: SourceItem[], opts: BuildOptions = {}): BuildResult {
	const cfg = DioCfg.parse(template);
	const old = cfg.comments();
	const use = opts.types ? items.filter((i) => opts.types!.includes(i.type)) : items;
	const sourceTypes = new Set(use.map((i) => i.type));
	const next = new Map<CommentKey, string>(opts.replace ? [...old].filter(([k]) => !sourceTypes.has(unkey(k)[0])) : old);

	const truncated: BuildResult['truncated'] = [];
	for (const item of use) {
		let text = cleanComment(item.text);
		if (!text) {
			continue;
		}
		if (text.length > MAX_COMMENT) {
			truncated.push({ type: item.type, no: item.no, text });
			text = text.slice(0, MAX_COMMENT);
		}
		next.set(key(item.type, item.no), text);
	}

	// Reihenfolge der Vorlage beibehalten, neue Einträge sortiert anhängen
	const existing = [...old.keys()].filter((k) => next.has(k));
	const appended = [...next.keys()]
		.filter((k) => !old.has(k))
		.sort((a, b) => {
			const [ta, na] = unkey(a);
			const [tb, nb] = unkey(b);
			return ta - tb || na - nb;
		});
	const ordered = new Map<CommentKey, string>([...existing, ...appended].map((k) => [k, next.get(k)!]));
	cfg.setComments(ordered);
	const output = cfg.encode();

	// Kontrolle: neu einlesen und vergleichen
	const check = DioCfg.parse(output);
	const got = check.comments();
	if (got.size !== ordered.size || [...ordered].some(([k, v]) => got.get(k) !== v)) {
		throw new Error('Kontrolle fehlgeschlagen: Kommentare stimmen nach dem Schreiben nicht überein.');
	}
	if (JSON.stringify(check.assignments()) !== JSON.stringify(cfg.assignments())) {
		throw new Error('Kontrolle fehlgeschlagen: Zuordnungen wurden verändert.');
	}
	for (const [name, rec] of cfg.records) {
		if (!name.startsWith('NAME_') && JSON.stringify(check.records.get(name)?.value) !== JSON.stringify(rec.value)) {
			throw new Error(`Kontrolle fehlgeschlagen: ${name} wurde verändert.`);
		}
	}

	const toChange = (k: CommentKey, before?: string, after?: string): Change => {
		const [type, no] = unkey(k);
		return { type, no, before, after };
	};
	const added = [...ordered].filter(([k]) => !old.has(k)).map(([k, v]) => toChange(k, undefined, v));
	const changed = [...ordered].filter(([k, v]) => old.has(k) && old.get(k) !== v).map(([k, v]) => toChange(k, old.get(k), v));
	const removed = [...old].filter(([k]) => !ordered.has(k)).map(([k, v]) => toChange(k, v));
	const perType = new Map<number, number>();
	for (const k of ordered.keys()) {
		const t = unkey(k)[0];
		perType.set(t, (perType.get(t) ?? 0) + 1);
	}
	return { output, comments: ordered, added, changed, removed, truncated, perType };
}

export function portLabel(type: number, no: number): string {
	return `${PORT_NAMES[type] ?? type}[${no}]`;
}

/** Kommentare einer DIOCFGSV.IO als Einträge für die E/A-Liste der Extension. */
export function ioEntriesFromDioCfg(buf: Buffer): { type: string; index: number; comment: string }[] {
	return [...DioCfg.parse(buf).comments()]
		.map(([k, comment]) => {
			const [t, index] = unkey(k);
			return { type: PORT_NAMES[t], index, comment };
		})
		.filter((e) => e.type && !e.type.startsWith('WS'));
}
