/**
 * Excel-Dateien lesen (.xls im BIFF8-Format und .xlsx), ohne Fremdbibliothek und
 * ohne installiertes Excel. Liefert je Blatt die Zellen als Text, so wie Excel sie
 * als Wert speichert (Zahlen ohne Nachkommastellen als Ganzzahl, Formeln mit ihrem
 * zuletzt berechneten Ergebnis). Formatierungen werden ignoriert.
 */
import * as zlib from 'zlib';

export type Sheet = string[][];
export type Workbook = Map<string, Sheet>;

export function readWorkbook(buf: Buffer): Workbook {
	if (buf.length >= 8 && buf.readUInt32LE(0) === 0xe011cfd0 && buf.readUInt32LE(4) === 0xe11ab1a1) {
		return readXls(buf);
	}
	if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
		return readXlsx(buf);
	}
	throw new Error('Keine Excel-Datei (.xls oder .xlsx).');
}

/** Zahl so darstellen, wie Excel sie als Wert liefert: 4193 statt 4193.0. */
export function formatNumber(v: number): string {
	if (Number.isInteger(v)) {
		return String(v);
	}
	return String(Number(v.toPrecision(15)));
}

function setCell(sheet: Sheet, row: number, col: number, value: string): void {
	if (value === '') {
		return; // leere Zellen nicht anlegen - .xls und .xlsx speichern sie unterschiedlich
	}
	while (sheet.length <= row) {
		sheet.push([]);
	}
	const r = sheet[row];
	while (r.length < col) {
		r.push('');
	}
	r[col] = value;
}

// --- .xls: Compound File (OLE2) ---------------------------------------------------------

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

function readCfbStream(buf: Buffer, names: string[]): Buffer | undefined {
	const sectorSize = 1 << buf.readUInt16LE(0x1e);
	const miniSectorSize = 1 << buf.readUInt16LE(0x20);
	const firstDirSector = buf.readUInt32LE(0x30);
	const miniCutoff = buf.readUInt32LE(0x38);
	const firstMiniFat = buf.readUInt32LE(0x3c);
	const firstDifat = buf.readUInt32LE(0x44);
	const sectorOffset = (s: number) => (s + 1) * sectorSize;

	// FAT-Sektoren aus DIFAT (109 im Kopf, Rest in einer Kette)
	const fatSectors: number[] = [];
	for (let i = 0; i < 109; i++) {
		const s = buf.readUInt32LE(0x4c + i * 4);
		if (s !== FREESECT && s !== ENDOFCHAIN) {
			fatSectors.push(s);
		}
	}
	let difat = firstDifat;
	const perSector = sectorSize / 4;
	for (let guard = 0; difat !== ENDOFCHAIN && difat !== FREESECT && guard < 100000; guard++) {
		const off = sectorOffset(difat);
		for (let i = 0; i < perSector - 1; i++) {
			const s = buf.readUInt32LE(off + i * 4);
			if (s !== FREESECT && s !== ENDOFCHAIN) {
				fatSectors.push(s);
			}
		}
		difat = buf.readUInt32LE(off + (perSector - 1) * 4);
	}
	const fat: number[] = [];
	for (const s of fatSectors) {
		const off = sectorOffset(s);
		for (let i = 0; i < perSector && off + i * 4 + 4 <= buf.length; i++) {
			fat.push(buf.readUInt32LE(off + i * 4));
		}
	}
	const chain = (start: number, table: number[]): number[] => {
		const out: number[] = [];
		let s = start;
		while (s !== ENDOFCHAIN && s !== FREESECT && s < table.length && out.length <= table.length) {
			out.push(s);
			s = table[s];
		}
		return out;
	};
	const readChain = (start: number): Buffer =>
		Buffer.concat(chain(start, fat).map((s) => buf.subarray(sectorOffset(s), sectorOffset(s) + sectorSize)));

	const dir = readChain(firstDirSector);
	interface Entry {
		name: string;
		type: number;
		start: number;
		size: number;
	}
	const entries: Entry[] = [];
	for (let off = 0; off + 128 <= dir.length; off += 128) {
		const nameLen = dir.readUInt16LE(off + 0x40);
		entries.push({
			name: dir.toString('utf16le', off, off + Math.max(0, nameLen - 2)),
			type: dir[off + 0x42],
			start: dir.readUInt32LE(off + 0x74),
			size: dir.readUInt32LE(off + 0x78)
		});
	}
	const root = entries.find((e) => e.type === 5);
	const entry = names.map((n) => entries.find((e) => e.type === 2 && e.name.toLowerCase() === n.toLowerCase())).find(Boolean);
	if (!entry || !root) {
		return undefined;
	}
	if (entry.size >= miniCutoff) {
		return readChain(entry.start).subarray(0, entry.size);
	}
	// kleine Streams liegen im Mini-Stream
	const miniFatBuf = readChain(firstMiniFat);
	const miniFat: number[] = [];
	for (let i = 0; i + 4 <= miniFatBuf.length; i += 4) {
		miniFat.push(miniFatBuf.readUInt32LE(i));
	}
	const ministream = readChain(root.start);
	return Buffer.concat(
		chain(entry.start, miniFat).map((s) => ministream.subarray(s * miniSectorSize, (s + 1) * miniSectorSize))
	).subarray(0, entry.size);
}

// --- .xls: BIFF8-Datensätze -----------------------------------------------------------------

interface BiffRecord {
	id: number;
	offset: number;
	data: Buffer;
}

function biffRecords(stream: Buffer, from = 0): BiffRecord[] {
	const out: BiffRecord[] = [];
	let p = from;
	while (p + 4 <= stream.length) {
		const id = stream.readUInt16LE(p);
		const len = stream.readUInt16LE(p + 2);
		out.push({ id, offset: p, data: stream.subarray(p + 4, p + 4 + len) });
		p += 4 + len;
	}
	return out;
}

/** Liest über CONTINUE-Grenzen hinweg; Zeichen werden nach einer Grenze mit neuem Flag-Byte fortgesetzt. */
class ContinuedReader {
	private part = 0;
	private pos = 0;
	constructor(private readonly parts: Buffer[]) {}

	private ensure(): void {
		while (this.part < this.parts.length && this.pos >= this.parts[this.part].length) {
			this.part++;
			this.pos = 0;
		}
	}
	get done(): boolean {
		this.ensure();
		return this.part >= this.parts.length;
	}
	bytes(n: number): Buffer {
		const chunks: Buffer[] = [];
		let left = n;
		while (left > 0) {
			this.ensure();
			if (this.part >= this.parts.length) {
				throw new Error('SST unvollständig');
			}
			const cur = this.parts[this.part];
			const take = Math.min(left, cur.length - this.pos);
			chunks.push(cur.subarray(this.pos, this.pos + take));
			this.pos += take;
			left -= take;
		}
		return Buffer.concat(chunks);
	}
	u8(): number {
		return this.bytes(1)[0];
	}
	u16(): number {
		return this.bytes(2).readUInt16LE(0);
	}
	i32(): number {
		return this.bytes(4).readInt32LE(0);
	}
	/** cch Zeichen; wechselt der Datensatz mitten im Text, folgt ein neues Flag-Byte. */
	chars(cch: number, highByte: boolean): string {
		let out = '';
		let left = cch;
		let wide = highByte;
		while (left > 0) {
			this.ensure();
			if (this.part >= this.parts.length) {
				throw new Error('SST unvollständig');
			}
			const cur = this.parts[this.part];
			const avail = Math.floor((cur.length - this.pos) / (wide ? 2 : 1));
			const take = Math.min(left, avail);
			const slice = cur.subarray(this.pos, this.pos + take * (wide ? 2 : 1));
			out += wide ? slice.toString('utf16le') : slice.toString('latin1');
			this.pos += take * (wide ? 2 : 1);
			left -= take;
			if (left > 0) {
				this.part++;
				this.pos = 0;
				wide = (this.u8() & 0x01) !== 0;
			}
		}
		return out;
	}
}

function readSst(parts: Buffer[]): string[] {
	const r = new ContinuedReader(parts);
	r.bytes(4); // cstTotal
	const unique = r.bytes(4).readUInt32LE(0);
	const out: string[] = [];
	for (let i = 0; i < unique && !r.done; i++) {
		const cch = r.u16();
		const flags = r.u8();
		const runs = flags & 0x08 ? r.u16() : 0;
		const ext = flags & 0x04 ? r.i32() : 0;
		out.push(r.chars(cch, (flags & 0x01) !== 0));
		if (runs) {
			r.bytes(runs * 4);
		}
		if (ext > 0) {
			r.bytes(ext);
		}
	}
	return out;
}

/** XLUnicodeString (16-Bit-Länge) bzw. ShortXLUnicodeString (8-Bit-Länge). */
function xlString(data: Buffer, offset: number, shortLen = false): string {
	const cch = shortLen ? data[offset] : data.readUInt16LE(offset);
	const p = offset + (shortLen ? 1 : 2);
	const wide = (data[p] & 0x01) !== 0;
	return wide ? data.toString('utf16le', p + 1, p + 1 + cch * 2) : data.toString('latin1', p + 1, p + 1 + cch);
}

function rkValue(rk: number): number {
	let v: number;
	if (rk & 0x02) {
		v = rk >> 2;
	} else {
		const b = Buffer.alloc(8);
		b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
		v = b.readDoubleLE(0);
	}
	return rk & 0x01 ? v / 100 : v;
}

function readXls(buf: Buffer): Workbook {
	const stream = readCfbStream(buf, ['Workbook', 'Book']);
	if (!stream) {
		throw new Error('Excel-Datei ohne Arbeitsmappe.');
	}
	const globals = biffRecords(stream);
	const bof = globals[0];
	if (!bof || bof.id !== 0x0809 || bof.data.readUInt16LE(0) !== 0x0600) {
		throw new Error('Nur Excel 97–2003 (.xls, BIFF8) und .xlsx werden unterstützt.');
	}
	const sheets: { name: string; offset: number }[] = [];
	let sst: string[] = [];
	for (let i = 0; i < globals.length; i++) {
		const rec = globals[i];
		if (rec.id === 0x0085 && rec.data[5] === 0) {
			sheets.push({ name: xlString(rec.data, 6, true), offset: rec.data.readUInt32LE(0) });
		} else if (rec.id === 0x00fc) {
			const parts = [rec.data];
			for (let j = i + 1; j < globals.length && globals[j].id === 0x003c; j++) {
				parts.push(globals[j].data);
			}
			sst = readSst(parts);
		} else if (rec.id === 0x000a) {
			break; // Ende der Globals
		}
	}

	const wb: Workbook = new Map();
	for (const s of sheets) {
		const sheet: Sheet = [];
		const recs = biffRecords(stream, s.offset);
		let pendingString: { row: number; col: number } | undefined;
		for (const rec of recs.slice(1)) {
			const d = rec.data;
			if (rec.id === 0x000a) {
				break;
			}
			switch (rec.id) {
				case 0x00fd: // LABELSST
					setCell(sheet, d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)] ?? '');
					break;
				case 0x0204: // LABEL
					setCell(sheet, d.readUInt16LE(0), d.readUInt16LE(2), xlString(d, 6));
					break;
				case 0x0203: // NUMBER
					setCell(sheet, d.readUInt16LE(0), d.readUInt16LE(2), formatNumber(d.readDoubleLE(6)));
					break;
				case 0x027e: // RK
					setCell(sheet, d.readUInt16LE(0), d.readUInt16LE(2), formatNumber(rkValue(d.readUInt32LE(6))));
					break;
				case 0x00bd: {
					// MULRK
					const row = d.readUInt16LE(0);
					const first = d.readUInt16LE(2);
					const n = (d.length - 6) / 6;
					for (let k = 0; k < n; k++) {
						setCell(sheet, row, first + k, formatNumber(rkValue(d.readUInt32LE(4 + k * 6 + 2))));
					}
					break;
				}
				case 0x0205: // BOOLERR
					setCell(sheet, d.readUInt16LE(0), d.readUInt16LE(2), d[7] ? '' : d[6] ? 'TRUE' : 'FALSE');
					break;
				case 0x0006: {
					// FORMULA: zuletzt berechnetes Ergebnis
					const row = d.readUInt16LE(0);
					const col = d.readUInt16LE(2);
					if (d.readUInt16LE(12) === 0xffff) {
						const kind = d[6];
						if (kind === 0) {
							pendingString = { row, col }; // Text folgt im STRING-Datensatz
						} else if (kind === 1) {
							setCell(sheet, row, col, d[8] ? 'TRUE' : 'FALSE');
						} else {
							setCell(sheet, row, col, '');
						}
					} else {
						setCell(sheet, row, col, formatNumber(d.readDoubleLE(6)));
					}
					break;
				}
				case 0x0207: // STRING (Ergebnis der vorigen Formel)
					if (pendingString) {
						setCell(sheet, pendingString.row, pendingString.col, xlString(d, 0));
						pendingString = undefined;
					}
					break;
			}
		}
		wb.set(s.name, sheet);
	}
	return wb;
}

// --- .xlsx: ZIP + XML -------------------------------------------------------------------------

function unzip(buf: Buffer): Map<string, Buffer> {
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) {
		throw new Error('Beschädigte .xlsx-Datei.');
	}
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	const files = new Map<string, Buffer>();
	for (let i = 0; i < count && buf.readUInt32LE(p) === 0x02014b50; i++) {
		const method = buf.readUInt16LE(p + 10);
		const compSize = buf.readUInt32LE(p + 20);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const local = buf.readUInt32LE(p + 42);
		const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
		const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
		const raw = buf.subarray(dataStart, dataStart + compSize);
		files.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
		p += 46 + nameLen + extraLen + commentLen;
	}
	return files;
}

function xmlText(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
		.replace(/&amp;/g, '&');
}

/** Text eines <si>/<is>-Elements: alle <t> außer Lautschrift (<rPh>). */
function richText(xml: string): string {
	const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
	let out = '';
	for (const m of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
		out += xmlText(m[1]);
	}
	return out;
}

function colIndex(ref: string): number {
	const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
	let n = 0;
	for (const ch of letters) {
		n = n * 26 + (ch.charCodeAt(0) - 64);
	}
	return n - 1;
}

function readXlsx(buf: Buffer): Workbook {
	const files = unzip(buf);
	const get = (name: string) => files.get(name)?.toString('utf8');
	const workbook = get('xl/workbook.xml');
	if (!workbook) {
		throw new Error('Keine Excel-Arbeitsmappe in der .xlsx-Datei.');
	}
	const rels = new Map<string, string>();
	for (const m of (get('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
		const id = /\bId="([^"]+)"/.exec(m[1])?.[1];
		const target = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
		if (id && target) {
			rels.set(id, target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, ''));
		}
	}
	const shared = [...(get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => richText(m[1]));
	const wb: Workbook = new Map();
	for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
		const name = xmlText(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? '');
		const rid = /\br:id="([^"]+)"/.exec(m[1])?.[1] ?? /\bid="([^"]+)"/.exec(m[1])?.[1] ?? '';
		const xml = get(rels.get(rid) ?? '') ?? '';
		const sheet: Sheet = [];
		for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
			const attrs = c[1];
			const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
			if (!ref) {
				continue;
			}
			const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
			const inner = c[2] ?? '';
			const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
			let value = '';
			if (type === 's') {
				value = shared[Number(v)] ?? '';
			} else if (type === 'inlineStr') {
				value = richText(inner);
			} else if (type === 'str' || type === 'e') {
				value = v !== undefined ? xmlText(v) : '';
			} else if (type === 'b') {
				value = v === '1' ? 'TRUE' : 'FALSE';
			} else if (v !== undefined) {
				value = formatNumber(Number(v));
			}
			setCell(sheet, parseInt(ref[2], 10) - 1, colIndex(ref[1]), value);
		}
		wb.set(name, sheet);
	}
	return wb;
}
