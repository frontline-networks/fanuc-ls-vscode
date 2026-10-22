/**
 * Änderungsbericht für einen Klon (#24): was würde beim Übertragen auf dem Roboter geändert?
 * Ohne VS-Code-Abhängigkeit, damit testbar.
 */
import { CloneChange } from './cloneCore';

export interface DiffLine {
	kind: ' ' | '-' | '+';
	text: string;
	/** Zeilenindex in der alten (-, ' ') bzw. neuen (+) Datei */
	oldLine?: number;
	newLine?: number;
}

/**
 * Zeilenweiser Vergleich (gemeinsamer Anfang/Ende abgeschnitten, Mitte per LCS).
 * Sehr große Mittelteile werden als Block ersetzt, statt Speicher zu sprengen.
 */
export function diffLines(oldText: string, newText: string, maxCells = 4_000_000): DiffLine[] {
	const a = splitLines(oldText);
	const b = splitLines(newText);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start++;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const out: DiffLine[] = [];
	for (let i = 0; i < start; i++) {
		out.push({ kind: ' ', text: a[i], oldLine: i, newLine: i });
	}
	const n = endA - start;
	const m = endB - start;
	if (n * m > maxCells) {
		for (let i = start; i < endA; i++) {
			out.push({ kind: '-', text: a[i], oldLine: i });
		}
		for (let j = start; j < endB; j++) {
			out.push({ kind: '+', text: b[j], newLine: j });
		}
	} else {
		// LCS-Tabelle von hinten
		const w = m + 1;
		const t = new Uint32Array((n + 1) * w);
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				t[i * w + j] = a[start + i] === b[start + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n || j < m) {
			if (i < n && j < m && a[start + i] === b[start + j]) {
				out.push({ kind: ' ', text: a[start + i], oldLine: start + i, newLine: start + j });
				i++;
				j++;
			} else if (i < n && (j >= m || t[(i + 1) * w + j] >= t[i * w + j + 1])) {
				out.push({ kind: '-', text: a[start + i], oldLine: start + i });
				i++;
			} else {
				out.push({ kind: '+', text: b[start + j], newLine: start + j });
				j++;
			}
		}
	}
	for (let k = 0; k < a.length - endA; k++) {
		out.push({ kind: ' ', text: a[endA + k], oldLine: endA + k, newLine: endB + k });
	}
	return out;
}

function splitLines(s: string): string[] {
	const lines = s.replace(/\r\n/g, '\n').split('\n');
	if (lines.length && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/** Nur die geänderten Stellen mit Kontext, als Unified-Diff-Text. */
export function unifiedHunks(diff: DiffLine[], context = 2, maxLines = 150): { text: string; truncated: boolean } {
	const show = new Set<number>();
	diff.forEach((d, i) => {
		if (d.kind !== ' ') {
			for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++) {
				show.add(k);
			}
		}
	});
	const lines: string[] = [];
	let last = -2;
	for (const i of [...show].sort((x, y) => x - y)) {
		if (i !== last + 1) {
			const d = diff[i];
			lines.push(`@@ Zeile ${(d.newLine ?? d.oldLine ?? 0) + 1} @@`);
		}
		lines.push(diff[i].kind + diff[i].text);
		last = i;
	}
	const truncated = lines.length > maxLines;
	return { text: (truncated ? lines.slice(0, maxLines) : lines).join('\n'), truncated };
}

export interface LsSummary {
	added: number;
	removed: number;
	/** geänderte TP-Zeilen (Nummern im /MN-Block, neuer Stand) */
	tpLines: number[];
	/** geänderte Positionen */
	positions: string[];
	/** geänderte Kopfangaben (/ATTR), z. B. COMMENT, DEFAULT_GROUP */
	attrs: string[];
}

/** Zusammenfassung für TP-Programme: welche Zeilen, Positionen und Kopfangaben sind betroffen. */
export function summarizeLs(diff: DiffLine[]): LsSummary {
	const s: LsSummary = { added: 0, removed: 0, tpLines: [], positions: [], attrs: [] };
	let section = '';
	let pos = '';
	const tp = new Set<number>();
	const positions = new Set<string>();
	const attrs = new Set<string>();
	for (const d of diff) {
		const sec = /^\s*\/([A-Z]+)/.exec(d.text);
		if (sec) {
			section = sec[1];
		}
		const p = /^\s*(PR?\[\s*\d+(?:\s*:[^\]]*)?\])\s*\{/.exec(d.text);
		if (p) {
			pos = p[1].replace(/\s+/g, '');
		}
		if (d.kind === ' ') {
			continue;
		}
		if (d.kind === '+') {
			s.added++;
		} else {
			s.removed++;
		}
		if (section === 'MN') {
			const num = /^\s*(\d+):/.exec(d.text);
			if (num) {
				tp.add(parseInt(num[1], 10));
			}
		} else if (section === 'POS' && pos) {
			positions.add(pos.replace(/:.*\]$/, ']'));
		} else if (section === 'ATTR') {
			const key = /^\s*([A-Z_]+)\s*[=:]/.exec(d.text)?.[1];
			if (key && !['MODIFIED', 'PROG_SIZE', 'MEMORY_SIZE', 'LINE_COUNT', 'FILE_NAME'].includes(key)) {
				attrs.add(key);
			}
		}
	}
	s.tpLines = [...tp].sort((a, b) => a - b);
	s.positions = [...positions];
	s.attrs = [...attrs];
	return s;
}

export interface ReportEntry {
	change: CloneChange;
	/** aktueller Stand auf dem Roboter (undefined: nicht vorhanden/nicht lesbar) */
	robotText?: string;
	/** Stand im Klon (undefined bei gelöschten Dateien) */
	localText?: string;
	/** Datei wurde auf dem Roboter seit dem Klonen geändert */
	conflict: boolean;
	error?: string;
}

export interface ReportInfo {
	controller: string;
	cloneRoot: string;
	created: Date;
	clonedAt?: string;
}

/** Zahlen kompakt als Bereiche: 3, 5–8, 12 */
export function compactNumbers(nums: number[]): string {
	const parts: string[] = [];
	for (let i = 0; i < nums.length; i++) {
		let j = i;
		while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) {
			j++;
		}
		parts.push(j > i ? `${nums[i]}–${nums[j]}` : String(nums[i]));
		i = j;
	}
	return parts.join(', ');
}

export function buildReport(info: ReportInfo, entries: ReportEntry[]): string {
	const p = (n: number) => String(n).padStart(2, '0');
	const fmt = (d: Date) => `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
	const stamp = fmt(info.created);
	const cloned = info.clonedAt && !isNaN(new Date(info.clonedAt).getTime()) ? fmt(new Date(info.clonedAt)) : info.clonedAt;
	const out: string[] = [
		`# Änderungsbericht – Klon von ${info.controller}`,
		'',
		`Erstellt am ${stamp}. Verglichen wird **💻 der Klon am PC (offline)** mit **🤖 dem aktuellen Stand auf ${info.controller} (online)** – also genau das, was beim Übertragen auf dem Roboter überschrieben würde.`,
		'',
		`Klon-Ordner: \`${info.cloneRoot}\`` + (cloned ? ` · geklont/abgeglichen: ${cloned}` : ''),
		''
	];
	if (entries.length === 0) {
		out.push('Keine Änderungen im Klon.');
		return out.join('\n');
	}
	const conflicts = entries.filter((e) => e.conflict);
	out.push('## Übersicht', '', '| Datei | Art | Änderung | Hinweis |', '|---|---|---|---|');
	for (const e of entries) {
		const kind = e.change.kind === 'modified' ? 'geändert' : e.change.kind === 'added' ? 'neu' : 'am PC gelöscht';
		let what = '';
		if (e.localText !== undefined && e.robotText !== undefined) {
			const diff = diffLines(e.robotText, e.localText);
			const plus = diff.filter((x) => x.kind === '+').length;
			const minus = diff.filter((x) => x.kind === '-').length;
			what = `+${plus} / −${minus} Zeilen`;
		} else if (e.localText !== undefined) {
			what = `${splitLines(e.localText).length} Zeilen`;
		}
		const hint = e.error
			? `⚠️ ${e.error}`
			: e.conflict
				? '⚠️ auf dem Roboter seit dem Klonen geändert – wird nicht übertragen'
				: e.change.kind === 'deleted'
					? 'bleibt auf dem Roboter (Löschen wird nicht übertragen)'
					: e.change.kind === 'added' && e.robotText === undefined
						? 'neu auf dem Roboter'
						: '';
		out.push(`| \`${e.change.relPath}\` → \`${e.change.remotePath}\` | ${kind} | ${what} | ${hint} |`);
	}
	out.push('');
	if (conflicts.length) {
		out.push(
			`> ⚠️ **${conflicts.length} Datei(en) wurden auf dem Roboter seit dem Klonen geändert.** Diese werden beim Übertragen übersprungen, damit nichts verloren geht. Bitte vergleichen und neu klonen.`,
			''
		);
	}
	for (const e of entries) {
		out.push(`## ${e.change.relPath}`, '');
		if (e.change.kind === 'deleted') {
			out.push('Die Datei wurde im Klon gelöscht. Auf dem Roboter bleibt sie erhalten.', '');
			continue;
		}
		if (e.localText === undefined) {
			out.push('Datei im Klon nicht lesbar.', '');
			continue;
		}
		const isLs = /\.ls$/i.test(e.change.relPath);
		if (e.robotText === undefined) {
			out.push(`Neue Datei (${splitLines(e.localText).length} Zeilen), auf dem Roboter noch nicht vorhanden.`, '');
			continue;
		}
		const diff = diffLines(e.robotText, e.localText);
		if (!diff.some((x) => x.kind !== ' ')) {
			out.push('Inhalt identisch mit dem Stand auf dem Roboter.', '');
			continue;
		}
		if (isLs) {
			const s = summarizeLs(diff);
			const facts: string[] = [];
			if (s.tpLines.length) {
				facts.push(`- Programmzeilen (neuer Stand): ${compactNumbers(s.tpLines)}`);
			}
			if (s.positions.length) {
				facts.push(`- Positionen: ${s.positions.join(', ')}`);
			}
			if (s.attrs.length) {
				facts.push(`- Kopfangaben: ${s.attrs.join(', ')}`);
			}
			out.push(...(facts.length ? facts : ['- nur Verwaltungsangaben (z. B. Änderungsdatum)']), '');
		}
		const hunks = unifiedHunks(diff);
		out.push('```diff', '--- Roboter (online)', '+++ Klon (offline)', hunks.text, '```');
		if (hunks.truncated) {
			out.push('', '_… gekürzt. Vollständig über „Klon: Änderungen anzeigen“ vergleichen._');
		}
		out.push('');
	}
	return out.join('\n');
}
