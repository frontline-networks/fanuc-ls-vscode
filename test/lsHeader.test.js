const test = require('node:test');
const assert = require('node:assert');
const H = require('../out/lsHeader');

const head = (attr, appl) =>
	['/PROG  PROG1', '/ATTR', ...attr, ...(appl ? ['/APPL', ...appl] : []), '/MN', '   1:  R[1]=0 ;', '/POS', '/END', ''].join('\r\n');

// Programm von einem älteren Roboter (ohne LOCAL_REGISTERS, TCD ohne TIME_SLICE)
const OLD = head([
	'OWNER\t\t= MNEDITOR;',
	'COMMENT\t\t= "Bauteil A";',
	'PROTECT\t\t= READ_WRITE;',
	'TCD:  STACK_SIZE\t= 0,',
	'      TASK_PRIORITY\t= 40,',
	'      BUSY_LAMP_OFF\t= 0,',
	'      ABORT_REQUEST\t= 0,',
	'      PAUSE_REQUEST\t= 0;',
	'DEFAULT_GROUP\t= 1,*,*,*,*;',
	'CONTROL_CODE\t= 00000000 00000000;'
], []);
// Vorlage vom Zielroboter (neuerer Stand, ArcTool)
const REF = head([
	'OWNER\t\t= MNEDITOR;',
	'COMMENT\t\t= "Vorlage";',
	'PROTECT\t\t= READ_WRITE;',
	'TCD:  STACK_SIZE\t= 0,',
	'      TASK_PRIORITY\t= 50,',
	'      TIME_SLICE\t= 0,',
	'      BUSY_LAMP_OFF\t= 0,',
	'      ABORT_REQUEST\t= 0,',
	'      PAUSE_REQUEST\t= 0;',
	'DEFAULT_GROUP\t= 1,1,*,*,*;',
	'CONTROL_CODE\t= 00000000 00000000;',
	'LOCAL_REGISTERS\t= 2,1,0;'
], ['ARC Welding Equipment : 1,*,*,*,*;']);

test('Kopf zerlegen und unverändert zusammensetzen', () => {
	for (const t of [OLD, REF]) {
		assert.strictEqual(H.joinLs(H.splitLs(t)), t);
	}
	const p = H.splitLs(REF);
	assert.deepStrictEqual(p.attr.map((e) => e.key), ['OWNER', 'COMMENT', 'PROTECT', 'TCD', 'DEFAULT_GROUP', 'CONTROL_CODE', 'LOCAL_REGISTERS']);
	assert.deepStrictEqual(p.appl.map((e) => e.key), ['ARC Welding Equipment']);
	assert.strictEqual(H.localRegisterCount(p), 3);
	assert.strictEqual(H.splitLs('/PROG X\n/MN\n'), undefined);
});

test('Kopf an Vorlage anpassen: Struktur der Vorlage, Werte des Programms', () => {
	const r = H.adaptHeader(OLD, REF);
	assert.ok(r.changed);
	assert.deepStrictEqual(r.added, ['TCD.TIME_SLICE', 'LOCAL_REGISTERS']);
	assert.deepStrictEqual(r.removed, []);
	const p = H.splitLs(r.text);
	const line = (k) => p.attr.find((e) => e.key === k).lines.join('\n');
	assert.match(line('COMMENT'), /Bauteil A/, 'Werte des Programms bleiben');
	assert.match(line('DEFAULT_GROUP'), /1,\*,\*,\*,\*/, 'Gruppen des Programms bleiben');
	assert.match(line('TCD'), /TASK_PRIORITY\t= 40/);
	assert.match(line('TCD'), /TIME_SLICE\t= 0/);
	assert.match(line('LOCAL_REGISTERS'), /= 0,0,0;/, 'lokale Register der Vorlage werden nicht übernommen');
	assert.deepStrictEqual(p.appl, [], 'APPL ohne Option unverändert');
	assert.ok(r.text.endsWith('/MN\r\n   1:  R[1]=0 ;\r\n/POS\r\n/END\r\n'), 'Programmteil unverändert, CRLF bleibt');
	// schon passend: keine Änderung
	assert.strictEqual(H.adaptHeader(r.text, REF).changed, false);
});

test('Umgekehrt: neueres Programm auf älteren Roboter', () => {
	const NEW = REF.replace('= 2,1,0;', '= 0,0,0;');
	const r = H.adaptHeader(NEW, OLD);
	assert.deepStrictEqual(r.removed, ['TCD.TIME_SLICE', 'LOCAL_REGISTERS']);
	assert.deepStrictEqual(r.warnings, []);
	assert.doesNotMatch(r.text, /LOCAL_REGISTERS|TIME_SLICE/);
	const used = H.adaptHeader(REF, OLD);
	assert.match(used.warnings.join(), /3 lokale Register/);
});

test('APPL optional ergänzen, eigene Blöcke bleiben', () => {
	const prog = OLD.replace('/APPL\r\n', '/APPL\r\nLINE_TRACK;\r\n  LINE_TRACK_SCHEDULE_NUMBER : 1;\r\n');
	const r = H.adaptHeader(prog, REF, { appl: true });
	assert.ok(r.added.includes('APPL ARC Welding Equipment'));
	assert.deepStrictEqual(r.keptAppl, ['LINE_TRACK']);
	const p = H.splitLs(r.text);
	assert.deepStrictEqual(p.appl.map((e) => e.key), ['LINE_TRACK', 'ARC Welding Equipment']);
	assert.strictEqual(p.appl[0].lines.length, 2, 'eingerückte Zeilen gehören zum Block');
});

test('Ladereihenfolge: aufgerufene Programme zuerst', () => {
	assert.deepStrictEqual(H.calledPrograms('  1:  CALL sub_a ;\n  2:  RUN TEST2 ;\n  3:  CALL SUB_A(1) ;'), ['SUB_A', 'TEST2']);
	const calls = new Map([['MAIN', ['SUB_A', 'SUB_B']], ['SUB_A', ['SUB_B']], ['SUB_B', []], ['X', ['X']]]);
	assert.deepStrictEqual(H.uploadOrder(['MAIN', 'X', 'SUB_A', 'SUB_B'], calls), ['SUB_B', 'SUB_A', 'MAIN', 'X']);
});
