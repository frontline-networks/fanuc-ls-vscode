/**
 * Programmkopf einer .LS an einen Roboter anpassen - ohne VS-Code-Abhängigkeit, damit testbar.
 *
 * Je nach Softwarestand und Optionen erwartet die Steuerung im Kopf andere Einträge, z. B.
 * LOCAL_REGISTERS (lokale Register, neuere Softwarestände), zusätzliche Einträge im TCD-Block
 * oder andere Blöcke im /APPL-Abschnitt (Arc Tool, Singularitätsvermeidung …). Diese Struktur
 * ist bei allen Programmen eines Roboters gleich. Ein Programm vom Zielroboter dient deshalb als
 * Vorlage: Seine Kopfstruktur wird übernommen, die Werte des jeweiligen Programms bleiben.
 *
 * Regeln:
 *   /ATTR  Einträge in der Reihenfolge der Vorlage. Vorhandene behalten ihren Wert, fehlende kommen
 *          mit dem Wert der Vorlage dazu (LOCAL_REGISTERS mit 0), Einträge, die die Vorlage nicht
 *          kennt, entfallen. Blöcke wie TCD werden auf die Untereinträge der Vorlage gebracht.
 *   /APPL  (optional) fehlende Blöcke der Vorlage kommen dazu; eigene Blöcke des Programms bleiben,
 *          weil sie vom Programm abhängen können (werden nur gemeldet).
 */

export interface HeaderEntry {
	/** z. B. "OWNER", "TCD", "ARC Welding Equipment" */
	key: string;
	/** Originalzeilen (erste Zeile nicht eingerückt, Fortsetzungen eingerückt) */
	lines: string[];
}

export interface LsParts {
	eol: string;
	/** Zeilen vor /ATTR (/PROG …) */
	head: string[];
	attr: HeaderEntry[];
	/** undefined: kein /APPL-Abschnitt */
	appl?: HeaderEntry[];
	/** ab dem ersten Abschnitt nach /ATTR bzw. /APPL (/MN, /POS, /END) */
	tail: string[];
}

const SECTION_RE = /^\/(\w+)/;

function entries(lines: string[]): HeaderEntry[] {
	const out: HeaderEntry[] = [];
	for (const line of lines) {
		const starts = line.trim() !== '' && !/^\s/.test(line);
		if (starts || out.length === 0) {
			out.push({ key: entryKey(line), lines: [line] });
		} else {
			out[out.length - 1].lines.push(line);
		}
	}
	return out;
}

function entryKey(line: string): string {
	const m = /^\s*([^:=;]+?)\s*[:=;]/.exec(line);
	return (m ? m[1] : line.trim()).replace(/\s+/g, ' ');
}

export function splitLs(text: string): LsParts | undefined {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.split(/\r?\n/);
	const sec = (name: string) => lines.findIndex((l) => SECTION_RE.exec(l)?.[1].toUpperCase() === name);
	const iAttr = sec('ATTR');
	if (iAttr < 0) {
		return undefined;
	}
	const next = (from: number) => {
		const k = lines.findIndex((l, i) => i > from && SECTION_RE.test(l));
		return k < 0 ? lines.length : k;
	};
	const attrEnd = next(iAttr);
	const iAppl = SECTION_RE.exec(lines[attrEnd] ?? '')?.[1].toUpperCase() === 'APPL' ? attrEnd : -1;
	const applEnd = iAppl >= 0 ? next(iAppl) : attrEnd;
	return {
		eol,
		head: lines.slice(0, iAttr),
		attr: entries(lines.slice(iAttr + 1, attrEnd)),
		appl: iAppl >= 0 ? entries(lines.slice(iAppl + 1, applEnd)) : undefined,
		tail: lines.slice(applEnd)
	};
}

export function joinLs(p: LsParts): string {
	const flat = (es: HeaderEntry[]) => es.flatMap((e) => e.lines);
	const lines = [...p.head, '/ATTR', ...flat(p.attr), ...(p.appl ? ['/APPL', ...flat(p.appl)] : []), ...p.tail];
	return lines.join(p.eol);
}

/** Untereinträge "NAME = Wert" eines Blocks (z. B. TCD), in Reihenfolge. */
function subItems(e: HeaderEntry): Map<string, string> {
	const out = new Map<string, string>();
	const text = e.lines.join(' ').replace(/^\s*[^:=]+:/, '');
	for (const m of text.matchAll(/([A-Z_][A-Z0-9_]*)\s*=\s*([^,;]*)/g)) {
		out.set(m[1], m[2].trim());
	}
	return out;
}

const isBlock = (e: HeaderEntry) => /^\s*[^:=;]+:/.test(e.lines[0]) && subItems(e).size > 0;

/** Block der Vorlage mit den Werten des Programms füllen (Format und Reihenfolge der Vorlage). */
function mergeBlock(target: HeaderEntry, ref: HeaderEntry): { entry: HeaderEntry; added: string[]; removed: string[] } {
	const t = subItems(target);
	const r = subItems(ref);
	const added = [...r.keys()].filter((k) => !t.has(k));
	const removed = [...t.keys()].filter((k) => !r.has(k));
	if (!added.length && !removed.length) {
		return { entry: target, added, removed };
	}
	const lines = ref.lines.map((l) => l.replace(/([A-Z_][A-Z0-9_]*)(\s*=\s*)([^,;]*)/g, (all, k: string, eq: string, v: string) => (t.has(k) ? `${k}${eq}${t.get(k)}` : `${k}${eq}${v}`)));
	return { entry: { key: ref.key, lines }, added: added.map((k) => `${ref.key}.${k}`), removed: removed.map((k) => `${ref.key}.${k}`) };
}

/** Neuer Eintrag aus der Vorlage; Werte, die nur das Vorlagenprogramm betreffen, werden neutral. */
function neutral(e: HeaderEntry): HeaderEntry {
	if (e.key === 'LOCAL_REGISTERS') {
		return { key: e.key, lines: e.lines.map((l) => l.replace(/=\s*([^;]*)/, (_, v: string) => '= ' + v.split(',').map(() => '0').join(','))) };
	}
	return e;
}

export interface AdaptOptions {
	/** /APPL-Abschnitt angleichen (fehlende Blöcke der Vorlage ergänzen) */
	appl?: boolean;
}

export interface AdaptResult {
	text: string;
	changed: boolean;
	/** ergänzte Einträge (ATTR, TCD.x, APPL) */
	added: string[];
	/** entfernte Einträge */
	removed: string[];
	/** Hinweise, z. B. lokale Register, die die Zielsteuerung nicht kennt */
	warnings: string[];
	/** nur im Programm vorhandene APPL-Blöcke (bleiben) */
	keptAppl: string[];
}

/** Zahl der lokalen Register laut LOCAL_REGISTERS (Summe), 0 wenn nicht vorhanden. */
export function localRegisterCount(parts: LsParts): number {
	const e = parts.attr.find((x) => x.key === 'LOCAL_REGISTERS');
	const v = e ? /=\s*([^;]*)/.exec(e.lines.join(' '))?.[1] ?? '' : '';
	return v.split(',').reduce((s, x) => s + (parseInt(x, 10) || 0), 0);
}

export function adaptHeader(targetText: string, refText: string, opts: AdaptOptions = {}): AdaptResult {
	const target = splitLs(targetText);
	const ref = splitLs(refText);
	const result: AdaptResult = { text: targetText, changed: false, added: [], removed: [], warnings: [], keptAppl: [] };
	if (!target || !ref) {
		result.warnings.push(!target ? 'kein /ATTR-Abschnitt im Programm' : 'kein /ATTR-Abschnitt in der Vorlage');
		return result;
	}
	const byKey = new Map(target.attr.map((e) => [e.key, e]));
	const attr: HeaderEntry[] = [];
	for (const r of ref.attr) {
		if (!r.key) {
			continue;
		}
		const t = byKey.get(r.key);
		if (!t) {
			attr.push(neutral(r));
			result.added.push(r.key);
		} else if (isBlock(r) && isBlock(t)) {
			const m = mergeBlock(t, r);
			attr.push(m.entry);
			result.added.push(...m.added);
			result.removed.push(...m.removed);
		} else {
			attr.push(t);
		}
	}
	const refKeys = new Set(ref.attr.map((e) => e.key));
	for (const t of target.attr) {
		if (t.key && !refKeys.has(t.key)) {
			result.removed.push(t.key);
		}
	}
	// Leerzeilen am Ende des Abschnitts erhalten
	const trailing = target.attr.length ? target.attr[target.attr.length - 1].lines.filter((l, i) => i > 0 && l.trim() === '') : [];
	if (trailing.length && attr.length && !attr[attr.length - 1].lines.some((l) => l.trim() === '')) {
		attr[attr.length - 1] = { ...attr[attr.length - 1], lines: [...attr[attr.length - 1].lines, ...trailing] };
	}
	if (result.removed.includes('LOCAL_REGISTERS') && localRegisterCount(target) > 0) {
		result.warnings.push(
			`Das Programm verwendet ${localRegisterCount(target)} lokale Register, die Zielsteuerung kennt keine lokalen Register (LOCAL_REGISTERS fehlt in der Vorlage). Das Programm muss angepasst werden.`
		);
	}

	let appl = target.appl;
	if (opts.appl && ref.appl) {
		const have = new Set((target.appl ?? []).map((e) => e.key));
		const missing = ref.appl.filter((e) => e.key && !have.has(e.key));
		appl = [...(target.appl ?? []), ...missing];
		result.added.push(...missing.map((e) => `APPL ${e.key}`));
		const refAppl = new Set(ref.appl.map((e) => e.key));
		result.keptAppl = (target.appl ?? []).filter((e) => e.key && !refAppl.has(e.key)).map((e) => e.key);
	}

	const text = joinLs({ ...target, attr, appl });
	result.text = text;
	result.changed = text !== targetText;
	return result;
}

/** Aufgerufene Programme (CALL/RUN), für die Ladereihenfolge. */
export function calledPrograms(text: string): string[] {
	const out = new Set<string>();
	for (const m of text.matchAll(/\b(?:CALL|RUN)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
		out.add(m[1].toUpperCase());
	}
	return [...out];
}

/**
 * Ladereihenfolge: aufgerufene Programme vor den aufrufenden (sonst bleibt die Reihenfolge).
 * names: Programmnamen in Großbuchstaben, calls: je Name die aufgerufenen Programme.
 */
export function uploadOrder(names: string[], calls: Map<string, string[]>): string[] {
	const set = new Set(names);
	const done = new Set<string>();
	const out: string[] = [];
	const visit = (n: string, stack: Set<string>) => {
		if (done.has(n) || stack.has(n)) {
			return;
		}
		stack.add(n);
		for (const c of calls.get(n) ?? []) {
			if (set.has(c)) {
				visit(c, stack);
			}
		}
		stack.delete(n);
		done.add(n);
		out.push(n);
	};
	for (const n of names) {
		visit(n, new Set());
	}
	return out;
}
