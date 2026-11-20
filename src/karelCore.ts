/**
 * Gliederung von KAREL-Quelltexten (.kl) - ohne VS-Code-Abhängigkeit, damit testbar.
 */

export type KarelSymbolKind = 'program' | 'routine' | 'external' | 'const' | 'var' | 'type';

export interface KarelSymbol {
	kind: KarelSymbolKind;
	name: string;
	/** z. B. Typ einer Variable, Parameter/Rückgabe einer Routine */
	detail: string;
	line: number;
	/** letzte Zeile (inklusive) */
	endLine: number;
	nameStart: number;
	children: KarelSymbol[];
}

/** Entfernt "--"-Kommentare außerhalb von Zeichenketten. */
export function stripKarelComment(line: string): string {
	let inString = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "'") {
			inString = !inString;
		} else if (!inString && c === '-' && line[i + 1] === '-') {
			return line.slice(0, i);
		}
	}
	return line;
}

const PROGRAM_RE = /^\s*PROGRAM\s+([A-Za-z_][A-Za-z0-9_]*)/i;
const ROUTINE_RE = /^\s*ROUTINE\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))?\s*(?::\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*\[[^\]]*\])?))?\s*(FROM\s+([A-Za-z_][A-Za-z0-9_]*))?/i;
const SECTION_RE = /^\s*(CONST|VAR|TYPE)\s*$/i;
const BEGIN_RE = /^\s*BEGIN\b/i;
const END_RE = /^\s*END\s+([A-Za-z_][A-Za-z0-9_]*)/i;

export function parseKarel(text: string): KarelSymbol[] {
	const lines = text.split(/\r?\n/);
	const result: KarelSymbol[] = [];
	let program: KarelSymbol | undefined;
	let routine: KarelSymbol | undefined;
	let section: 'const' | 'var' | 'type' | undefined;

	const owner = (): KarelSymbol[] => (routine ? routine.children : program ? program.children : result);

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const line = stripKarelComment(raw);
		if (!line.trim() || /^\s*%/.test(line)) {
			continue;
		}

		const p = PROGRAM_RE.exec(line);
		if (p && !program) {
			program = sym('program', p[1], '', i, raw.indexOf(p[1]));
			result.push(program);
			section = undefined;
			continue;
		}

		const r = ROUTINE_RE.exec(line);
		if (r) {
			const params = r[2] ? r[2].replace(/\s+/g, ' ') : '()';
			const ret = r[3] ? ` : ${r[3].replace(/\s+/g, ' ')}` : '';
			const external = !!r[4];
			const s = sym(external ? 'external' : 'routine', r[1], params + ret + (external ? ` FROM ${r[5]}` : ''), i, raw.indexOf(r[1]));
			(program ? program.children : result).push(s);
			routine = external ? undefined : s;
			section = undefined;
			continue;
		}

		const sec = SECTION_RE.exec(line);
		if (sec) {
			section = sec[1].toLowerCase() as 'const' | 'var' | 'type';
			continue;
		}

		if (BEGIN_RE.test(line)) {
			section = undefined;
			continue;
		}

		const e = END_RE.exec(line);
		if (e) {
			const name = e[1].toUpperCase();
			if (routine && routine.name.toUpperCase() === name) {
				routine.endLine = i;
				routine = undefined;
			} else if (program && program.name.toUpperCase() === name) {
				program.endLine = i;
			}
			section = undefined;
			continue;
		}

		if (!section) {
			continue;
		}
		if (section === 'var') {
			// name1, name2 {IN CMOS} : TYPE
			const m = /^\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*(?:IN\s+\w+\s*)?:\s*(.+?)\s*$/i.exec(line);
			if (m) {
				for (const name of m[1].split(',').map((n) => n.trim())) {
					owner().push(sym('var', name, m[2], i, raw.indexOf(name)));
				}
			}
		} else if (section === 'const') {
			const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line);
			if (m) {
				owner().push(sym('const', m[1], `= ${m[2]}`, i, raw.indexOf(m[1])));
			}
		} else if (section === 'type') {
			const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line);
			if (m) {
				const t = sym('type', m[1], m[2], i, raw.indexOf(m[1]));
				if (/^STRUCTURE\b/i.test(m[2])) {
					// bis ENDSTRUCTURE
					let j = i + 1;
					while (j < lines.length && !/^\s*ENDSTRUCTURE\b/i.test(stripKarelComment(lines[j]))) {
						j++;
					}
					t.endLine = Math.min(j, lines.length - 1);
					i = t.endLine;
				}
				owner().push(t);
			}
		}
	}
	if (program && program.endLine === program.line) {
		program.endLine = lines.length - 1;
	}
	return result;
}

function sym(kind: KarelSymbolKind, name: string, detail: string, line: number, nameStart: number): KarelSymbol {
	return { kind, name, detail, line, endLine: line, nameStart: Math.max(nameStart, 0), children: [] };
}

// --- ktrans: robot.ini --------------------------------------------------------------------

/**
 * robot.ini legt fest, mit welchen Support-Dateien (Softwarestand, Optionen wie ArcTool) ktrans
 * übersetzt. Fehlt sie, meldet ktrans "Unable to find 'robot.ini', Using basic KAREL support files"
 * und kennt nur die Grund-Systemvariablen: $AWSCFG, $AWEPOR usw. sind dann "Id must be defined
 * before this use". Eine passende robot.ini liegt im Roboterordner einer ROBOGUIDE-Zelle oder wird
 * mit setrobot.exe (WinOLPC) erzeugt.
 */
export interface RobotIni {
	robot?: string;
	version?: string;
	path?: string;
	support?: string;
	output?: string;
}

export function parseRobotIni(text: string): RobotIni | undefined {
	if (!/^\s*\[WinOLPC_Util\]/im.test(text)) {
		return undefined;
	}
	const out: RobotIni = {};
	for (const line of text.split(/\r?\n/)) {
		const m = /^\s*(Robot|Version|Path|Support|Output)\s*=\s*(.*?)\s*$/i.exec(line);
		if (m) {
			out[m[1].toLowerCase() as keyof RobotIni] = m[2];
		}
	}
	return out;
}

/** Steht in den ktrans-Argumenten schon /config? */
export function hasConfigArg(args: string): boolean {
	return /(^|\s)[/-]config(\s|$)/i.test(args);
}

/** Verwendet der Quelltext Systemvariablen ($…) außerhalb von Kommentaren und Zeichenketten? */
export function usesSystemVariables(text: string): boolean {
	return text.split(/\r?\n/).some((l) => /\$[A-Za-z_]/.test(stripKarelComment(l).replace(/'[^']*'/g, '')));
}

/**
 * Ordner, in denen eine robot.ini gesucht wird: Ordner der .kl-Datei und seine Elternordner bis
 * einschließlich des Arbeitsbereichsordners (Windows- und POSIX-Pfade).
 */
export function robotIniSearchDirs(fileDir: string, workspaceRoots: string[]): string[] {
	const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase().replace(/\\/g, '/');
	const root = workspaceRoots.map(norm).filter((r) => norm(fileDir) === r || norm(fileDir).startsWith(r + '/')).sort((a, b) => b.length - a.length)[0];
	const dirs: string[] = [];
	let dir = fileDir.replace(/[\\/]+$/, '');
	for (;;) {
		dirs.push(dir);
		if (!root || norm(dir) === root) {
			break;
		}
		const i = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
		if (i <= 0 || /^[A-Za-z]:$/.test(dir.slice(0, i))) {
			break;
		}
		dir = dir.slice(0, i);
	}
	return dirs;
}

/**
 * Befehlszeile für das Terminal; PowerShell braucht "&" vor einem Programmpfad in Anführungszeichen.
 * Mit /config (robot.ini) übersetzt ktrans im Output-Ordner des Roboters und kopiert die .pc selbst
 * neben die Quelle. Eine zusätzlich angegebene Zieldatei führt dann zu „Copy to/from source directory
 * failed: 32“ (die Datei ist noch offen) – deshalb wird sie in diesem Fall weggelassen.
 */
export function ktransCommandLine(ktrans: string, source: string, output: string, args: string, robotIni: string | undefined, powershell: boolean): string {
	const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
	const withConfig = hasConfigArg(args) || !!robotIni;
	const parts = withConfig ? [quote(ktrans), quote(source)] : [quote(ktrans), quote(source), quote(output)];
	if (args) {
		parts.push(args);
	}
	if (robotIni && !hasConfigArg(args)) {
		parts.push('/config', quote(robotIni));
	}
	return (powershell && /\s/.test(ktrans) ? '& ' : '') + parts.join(' ');
}
