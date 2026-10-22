/**
 * Filter für die Baumansichten (#20) - ohne VS-Code-Abhängigkeit, damit testbar.
 */

export interface FileTypeGroup {
	id: string;
	label: string;
	extensions: string[];
}

export const FILE_TYPE_GROUPS: FileTypeGroup[] = [
	{ id: 'tp', label: 'TP-Programme (.LS, .TP)', extensions: ['ls', 'tp'] },
	{ id: 'karel', label: 'KAREL (.KL, .PC)', extensions: ['kl', 'pc'] },
	{ id: 'vars', label: 'Variablen und Systemdateien (.VA, .VR, .SV)', extensions: ['va', 'vr', 'sv'] },
	{ id: 'io', label: 'E/A-Konfiguration (.IO)', extensions: ['io'] },
	{ id: 'lists', label: 'Listen und Diagnose (.DG, .DT, .TXT, .LOG)', extensions: ['dg', 'dt', 'txt', 'log', 'ls_'] },
	{ id: 'other', label: 'Andere Dateien', extensions: [] }
];

export interface FileFilter {
	/** IDs aus FILE_TYPE_GROUPS; leer = alle Typen */
	groups: string[];
	/** Teil des Dateinamens (ohne Groß-/Kleinschreibung), * und ? als Platzhalter */
	text: string;
}

export const NO_FILTER: FileFilter = { groups: [], text: '' };

export function isActive(f: FileFilter): boolean {
	return f.groups.length > 0 || f.text.trim() !== '';
}

function groupOf(name: string): string {
	const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
	return FILE_TYPE_GROUPS.find((g) => g.extensions.includes(ext))?.id ?? 'other';
}

/** Textmuster: "home" = enthält, "H*.LS" = Platzhalter. */
export function matchesText(name: string, text: string): boolean {
	const t = text.trim().toLowerCase();
	if (!t) {
		return true;
	}
	const n = name.toLowerCase();
	if (/[*?]/.test(t)) {
		const re = new RegExp('^' + t.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
		return re.test(n);
	}
	return n.includes(t);
}

export function matchesFileFilter(name: string, f: FileFilter): boolean {
	return (f.groups.length === 0 || f.groups.includes(groupOf(name))) && matchesText(name, f.text);
}

export function describeFilter(f: FileFilter): string {
	const parts: string[] = [];
	if (f.groups.length) {
		parts.push(f.groups.map((g) => FILE_TYPE_GROUPS.find((x) => x.id === g)?.label.replace(/ \(.*\)$/, '') ?? g).join(', '));
	}
	if (f.text.trim()) {
		parts.push(`„${f.text.trim()}“`);
	}
	return parts.join(' · ');
}
