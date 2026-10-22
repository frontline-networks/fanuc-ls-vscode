/**
 * KAREL-Programm erzeugen, das E/A-Kommentare auf dem Roboter setzt (#21).
 * Die Steuerung erlaubt kein Hochladen geänderter E/A-Listen (IOSTATE.DG ist eine
 * Diagnose-Ausgabe, DIOCFGSV.IO binär und nur beim Kaltstart ladbar). Der dokumentierte
 * Weg ist das KAREL-Built-in SET_PORT_CMT. Ohne VS-Code-Abhängigkeit, damit testbar.
 */
import { IoEntry, IoType, compareEntries } from './ioCore';

/** Port-Typ-Konstanten für SET_PORT_CMT (vordefinierte KAREL-Bezeichner). */
export const KAREL_PORT_TYPES: Partial<Record<IoType, string>> = {
	DI: 'io_din',
	DO: 'io_dout',
	AI: 'io_anin',
	AO: 'io_anout',
	RI: 'io_rdi',
	RO: 'io_rdo',
	GI: 'io_gpin',
	GO: 'io_gpout',
	UI: 'io_ui',
	UO: 'io_uo',
	SI: 'io_sopin',
	SO: 'io_sopout',
	WI: 'io_wdi',
	WO: 'io_wdo',
	F: 'io_flag'
};

export const KAREL_PROGRAM_NAME = 'FLIOCMT';
/** Maximale Kommentarlänge für E/A-Kommentare */
export const IO_COMMENT_MAX = 24;

export interface KarelIoResult {
	source: string;
	written: number;
	/** gekürzte Kommentare (Typ[Nr]) */
	truncated: string[];
	/** Typen, die SET_PORT_CMT nicht unterstützt */
	skipped: string[];
}

/** Kommentar für ein KAREL-Zeichenkettenliteral: ASCII, ohne Hochkomma, gekürzt. */
export function karelComment(s: string): string {
	return s
		.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
		.replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
		.replace(/'/g, '`')
		.replace(/[^\x20-\x7e]/g, '')
		.trim();
}

export function buildIoCommentProgram(entries: IoEntry[], controller: string): KarelIoResult {
	const lines: string[] = [];
	const truncated: string[] = [];
	const skipped = new Set<string>();
	let written = 0;
	for (const e of [...entries].sort(compareEntries)) {
		const port = KAREL_PORT_TYPES[e.type];
		if (!port) {
			skipped.add(e.type);
			continue;
		}
		let c = karelComment(e.comment);
		if (c.length > IO_COMMENT_MAX) {
			c = c.slice(0, IO_COMMENT_MAX).trimEnd();
			truncated.push(`${e.type}[${e.index}]`);
		}
		lines.push(`  setc(${port}, ${e.index}, '${c}')`);
		written++;
	}
	const source = [
		`PROGRAM ${KAREL_PROGRAM_NAME}`,
		`-- Erzeugt von FANUC TP (LS) fuer ${karelComment(controller)}: setzt ${written} E/A-Kommentar(e).`,
		'-- Einmal am Programmierhandgeraet ausfuehren, danach kann das Programm geloescht werden.',
		'%NOLOCKGROUP',
		"%COMMENT = 'E/A-Kommentare'",
		'VAR',
		'  status : INTEGER',
		'  n_ok   : INTEGER',
		'  n_err  : INTEGER',
		'',
		'ROUTINE setc(port_type : INTEGER; port_no : INTEGER; cmt : STRING)',
		'BEGIN',
		'  SET_PORT_CMT(port_type, port_no, cmt, status)',
		'  IF status = 0 THEN',
		'    n_ok = n_ok + 1',
		'  ELSE',
		'    n_err = n_err + 1',
		"    WRITE TPERROR('Kommentar ', port_type, '/', port_no, ' Fehler ', status, CR)",
		'  ENDIF',
		'END setc',
		'',
		'BEGIN',
		'  n_ok = 0',
		'  n_err = 0',
		...lines,
		"  WRITE TPDISPLAY(CHR(128), CHR(137), 'E/A-Kommentare gesetzt: ', n_ok, CR)",
		'  IF n_err > 0 THEN',
		"    WRITE TPDISPLAY('Fehler: ', n_err, ' (siehe Alarmliste)', CR)",
		'  ENDIF',
		`END ${KAREL_PROGRAM_NAME}`,
		''
	].join('\r\n');
	return { source, written, truncated, skipped: [...skipped] };
}

/** Diagnose- und Berichtsdateien der Steuerung: nur lesbar, nicht hochladbar. */
export function isReadOnlyReport(fileName: string): boolean {
	const n = fileName.toUpperCase();
	return /\.DG$/.test(n) || /^(ERR[A-Z]*|LOGBOOK|SUMMARY|SYSTEM|TPACCN|HISTORY|IOSTATE|PRGSTATE|CONFIG)\.(LS|DG|TXT)$/.test(n);
}
