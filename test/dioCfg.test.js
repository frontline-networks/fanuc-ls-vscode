const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readWorkbook } = require('../out/excelReader');
const D = require('../out/dioCfg');

// --- Vorlage nach dem Dateiformat von Hand bauen (unabhängig vom Encoder) ---
function rec(name, t1, t2, payload) {
	return Buffer.concat([Buffer.from([0xfc]), Buffer.from(name + '\0', 'latin1'), Buffer.from([t1, t2, 0]), payload]);
}
function scalar(name, v) {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(v);
	return rec(name, 0x00, 16, b);
}
function ints(name, size, values) {
	const head = Buffer.alloc(4);
	head.writeUInt16BE(values.length, 0);
	head.writeUInt16BE(size, 2);
	const data = Buffer.alloc(values.length * size + ((4 - ((values.length * size) % 4)) % 4));
	values.forEach((v, i) => (size === 1 ? data.writeUInt8(v, i) : data.writeUInt16BE(v, i * 2)));
	return rec(name, 0x20, size === 1 ? 24 : 23, Buffer.concat([head, data]));
}
function strings(name, values, maxLen = 16, size = 20) {
	const head = Buffer.alloc(4);
	head.writeUInt16BE(values.length, 0);
	head.writeUInt16BE(size, 2);
	const data = Buffer.alloc(values.length * size + ((4 - ((values.length * size) % 4)) % 4));
	values.forEach((v, i) => {
		data[i * size] = maxLen;
		data[i * size + 1] = v.length;
		data.write(v, i * size + 2, 'latin1');
	});
	return rec(name, 0x3f, maxLen, Buffer.concat([head, data]));
}
const HEADER = Buffer.concat([Buffer.from([0x41, 0xce, 0xfd]), Buffer.from('DIO____EMAIN', 'latin1'), Buffer.from([0, 0, 0, 4, 0, 0, 0x1b, 0, 0, 0, 0, 0])]);
const TEMPLATE = Buffer.concat([
	HEADER,
	scalar('$$VERSION', 940583),
	ints('ASG_LOG_PT', 1, [1, 2]),
	ints('ASG_LOG_PN', 2, [1, 1]),
	ints('ASG_N_PTS', 2, [40, 40]),
	ints('ASG_RACK_NO', 1, [0, 0]),
	ints('ASG_SLOT_NO', 1, [1, 1]),
	ints('ASG_PHY_PT', 1, [1, 2]),
	ints('ASG_PHY_PN', 2, [1, 1]),
	ints('NAME_LOG_PT', 1, [11, 1, 2]),
	ints('NAME_LOG_PN', 2, [1, 1, 12]),
	strings('NAME_NAME', ['Fault reset SOP ', 'Alter Kommentar', 'Greifer offen']),
	strings('NAME_NAME2', ['In', '', '']),
	strings('DEV_COMMENT', [], 21, 24)
]);
const XLS = readWorkbook(fs.readFileSync(path.join(__dirname, 'fixtures', 'signals.xls')));
const XLSX = readWorkbook(fs.readFileSync(path.join(__dirname, 'fixtures', 'signals.xlsx')));

test('Excel lesen: .xls (BIFF8, lange Texttabelle) und .xlsx liefern dasselbe', () => {
	assert.deepStrictEqual([...XLS.keys()], ['PlcToRob', 'RobToPlc', 'GI', 'GO', 'Zahlen']);
	for (const name of ['PlcToRob', 'RobToPlc', 'GI', 'GO']) {
		assert.deepStrictEqual(XLSX.get(name), XLS.get(name), name);
	}
	assert.deepStrictEqual(XLS.get('PlcToRob')[3].slice(0, 2), ['3', ' Größe prüfen µ° ']);
	assert.strictEqual(XLS.get('PlcToRob')[709][1], 'Signal_0699_mit_langem_Namen');
	const z = XLS.get('Zahlen');
	assert.deepStrictEqual([z[0][0], z[0][1], z[0][2], z[1][3]], ['1.5', '-3', '10000000000', '0.1']);
	assert.strictEqual(XLSX.get('Zahlen')[0][4] ?? '', '', 'Formel ohne gespeichertes Ergebnis bleibt leer');
	assert.throws(() => readWorkbook(Buffer.from('kein excel')), /Keine Excel-Datei/);
});

test('DIOCFGSV.IO lesen, unverändert wieder schreiben', () => {
	const cfg = D.DioCfg.parse(TEMPLATE);
	assert.strictEqual(cfg.version, 940583);
	assert.deepStrictEqual([...cfg.comments()], [['11:1', 'Fault reset SOP In'], ['1:1', 'Alter Kommentar'], ['2:12', 'Greifer offen']]);
	assert.deepStrictEqual(cfg.assignments()[1], { type: 2, start: 1, count: 40, rack: 0, slot: 1, phyType: 2, phyStart: 1 });
	assert.ok(cfg.encode().equals(TEMPLATE), 'Lesen + Schreiben ändert nichts');
	assert.throws(() => D.DioCfg.parse(Buffer.from('xx\xfcNAME\0')), /Keine DIOCFGSV/);
});

test('Signal-Excel lesen: Spalten, Typen, übersprungene Blätter', () => {
	const r = D.readSignalWorkbook(XLS);
	const notes = Object.fromEntries(r.notes.map((n) => [n.source, n.rows ?? n.skipped]));
	assert.strictEqual(notes.PlcToRob, 705);
	assert.strictEqual(notes.RobToPlc, 2);
	assert.strictEqual(notes.GI, 1, 'Spalte "Signal name" wird gefunden');
	assert.match(String(notes.GO), /Flag-Kommentare/);
	assert.ok(r.items.every((i) => Number.isInteger(i.no)));
});

test('Excel → DIOCFGSV.IO zusammenführen (#Konverter)', () => {
	const items = D.readSignalWorkbook(XLS).items;
	const r = D.buildDioCfg(TEMPLATE, items);
	const c = r.comments;
	assert.strictEqual(c.get('1:1'), 'Teil vorhanden', 'vorhandener Kommentar wird ersetzt');
	assert.strictEqual(c.get('11:1'), 'Fault reset SOP In', 'andere Typen bleiben');
	assert.strictEqual(c.get('1:3'), 'Groesse pruefen udeg', 'Umlaute, µ, ° umgeschrieben und getrimmt');
	assert.strictEqual(c.get('1:5'), 'Unicode ? Pfeil');
	assert.strictEqual(c.get('1:4'), 'Sehr langer Signalname u');
	const cut = r.truncated.map((t) => D.portLabel(t.type, t.no));
	assert.ok(cut.includes('DI[4]') && !cut.includes('DI[5]'));
	assert.strictEqual(cut.length, 701, 'DI[4] und die 700 langen Füllnamen');
	assert.ok(!c.has('1:2'), 'leere Kommentare werden nicht übernommen');
	assert.strictEqual(c.get('2:12'), 'Greifer zu');
	assert.strictEqual(c.get('18:201'), 'SelectPrgNum1');
	assert.deepStrictEqual([...c.keys()].slice(0, 3), ['11:1', '1:1', '2:12'], 'Reihenfolge der Vorlage bleibt');
	assert.deepStrictEqual(r.changed.map((x) => D.portLabel(x.type, x.no)), ['DI[1]', 'DO[12]']);
	assert.strictEqual(r.removed.length, 0);
	assert.strictEqual(r.perType.get(1), 704);
	// Ergebnis ist eine gültige Datei mit unveränderten Zuordnungen
	const back = D.DioCfg.parse(r.output);
	assert.deepStrictEqual([...back.comments()], [...c]);
	assert.deepStrictEqual(back.assignments(), D.DioCfg.parse(TEMPLATE).assignments());
	const name = back.records.get('NAME_NAME').value;
	const name2 = back.records.get('NAME_NAME2').value;
	assert.strictEqual(name[1] + name2[1], 'Teil vorhanden');
	assert.ok(name.every((s) => s.length <= 16) && name2.every((s) => s.length <= 8));
});

test('Ersetzen und Typauswahl', () => {
	const items = D.readSignalWorkbook(XLS).items;
	const replaced = D.buildDioCfg(TEMPLATE, items, { replace: true, types: [D.PORT_TYPES.DO] });
	assert.deepStrictEqual([...replaced.comments.keys()], ['11:1', '1:1', '2:12'], 'nur DO ersetzt, DI unberührt');
	assert.strictEqual(replaced.comments.get('2:12'), 'Greifer zu');
	const onlyDi = D.buildDioCfg(TEMPLATE, items, { replace: true, types: [D.PORT_TYPES.DI] });
	assert.ok(!onlyDi.comments.has('2:12') || onlyDi.comments.get('2:12') === 'Greifer offen');
	assert.deepStrictEqual(onlyDi.removed.map((x) => D.portLabel(x.type, x.no)), []);
	assert.strictEqual(D.cleanComment('  Ölstand  '), 'Oelstand');
});

test('VARS-004/032 vermeiden: Zuordnungsprüfung, Testdatei, Vergleich (#Ladefehler)', () => {
	const items = [
		{ type: 1, no: 5, text: 'Zugeordnet', source: 't' },
		{ type: 1, no: 4193, text: 'Nicht zugeordnet', source: 't' },
		{ type: 18, no: 201, text: 'GI ohne Zuordnungsdaten', source: 't' },
		{ type: 1, no: 1, text: 'Neuer Text', source: 't' }
	];
	const tplAsg = D.DioCfg.parse(TEMPLATE).assignments();
	assert.strictEqual(D.isAssigned(tplAsg, 1, 40), true);
	assert.strictEqual(D.isAssigned(tplAsg, 1, 41), false);
	assert.strictEqual(D.isAssigned(tplAsg, 18, 201), undefined, 'Typ ohne Zuordnungen in der Vorlage: unbekannt');

	const all = D.buildDioCfg(TEMPLATE, items);
	assert.deepStrictEqual(all.unassigned.map((i) => D.portLabel(i.type, i.no)), ['DI[4193]']);
	assert.ok(all.comments.has('1:4193'));

	const assigned = D.buildDioCfg(TEMPLATE, items, { onlyAssigned: true });
	assert.ok(!assigned.comments.has('1:4193'));
	assert.ok(assigned.comments.has('18:201') && assigned.comments.has('1:5'));
	assert.strictEqual(assigned.skipped, 1);

	const test = D.buildDioCfg(TEMPLATE, items, { onlyExisting: true, replace: true });
	assert.deepStrictEqual([...test.comments.keys()], ['11:1', '1:1', '2:12'], 'Feldlängen wie in der Vorlage');
	assert.strictEqual(test.comments.get('1:1'), 'Neuer Text');
	const back = D.DioCfg.parse(test.output);
	for (const n of ['NAME_LOG_PT', 'NAME_LOG_PN', 'NAME_NAME', 'NAME_NAME2']) {
		assert.strictEqual(back.records.get(n).value.length, 3, n);
	}

	// Vergleich mit dem Zielroboter
	const tpl = D.DioCfg.parse(TEMPLATE);
	assert.deepStrictEqual(D.compareDioCfg(D.DioCfg.parse(all.output), tpl), { errors: [], warnings: [] });
	const other = Buffer.concat([HEADER, scalar('$$VERSION', 123), ints('ASG_LOG_PT', 1, [1]), ints('NAME_LOG_PT', 1, []), ints('NAME_LOG_PN', 2, []), strings('NAME_NAME', []), strings('NAME_NAME2', [])]);
	const cmp = D.compareDioCfg(tpl, D.DioCfg.parse(other));
	assert.match(cmp.errors.join('\n'), /Softwarestand.*940583.*123/);
	assert.match(cmp.errors.join('\n'), /nicht kennt: ASG_LOG_PN/);
	assert.match(cmp.warnings.join('\n'), /Zuordnungen weichen ab/);

	const md = D.dioReport('Vorlage', tpl, 'Roboter', D.DioCfg.parse(other));
	assert.match(md, /Softwarestand \(\$\$VERSION\): 940583/);
	assert.match(md, /DI: 1–40 \(Rack 0, Slot 1\)/);
	assert.match(md, /\| NAME_NAME \| Textfeld \| 63\/16 \| 20 \| 3 \|/);
	assert.match(md, /NAME_NAME: 3 hier, 0 in Roboter/);
});
