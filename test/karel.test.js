const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const K = require('../out/karelCore');

test('Kommentare entfernen, Zeichenketten beachten', () => {
	assert.strictEqual(K.stripKarelComment("a = 1 -- Kommentar"), 'a = 1 ');
	assert.strictEqual(K.stripKarelComment("WRITE('a--b') -- x"), "WRITE('a--b') ");
});

test('Gliederung eines KAREL-Programms (#6)', () => {
	const text = fs.readFileSync(path.join(__dirname, '..', 'examples', 'ZAEHLER.KL'), 'utf8');
	const syms = K.parseKarel(text);
	assert.strictEqual(syms.length, 1);
	const prog = syms[0];
	assert.deepStrictEqual([prog.kind, prog.name], ['program', 'zaehler']);
	assert.strictEqual(prog.endLine, text.split('\n').findIndex((l) => l.startsWith('END zaehler')));
	const summary = prog.children.map((c) => [c.kind, c.name]);
	assert.deepStrictEqual(summary, [
		['const', 'REG_ZAEHLER'],
		['const', 'MAX_TEILE'],
		['type', 'statistik_t'],
		['var', 'stat'],
		['var', 'status'],
		['var', 'anzahl'],
		['var', 'real_flag'],
		['var', 'real_wert'],
		['external', 'lese_zaehler'],
		['routine', 'melde'],
		['routine', 'voll']
	]);
	const voll = prog.children.find((c) => c.name === 'voll');
	assert.strictEqual(voll.detail, '(n : INTEGER) : BOOLEAN');
	assert.deepStrictEqual(voll.children.map((c) => [c.kind, c.name, c.detail]), [['var', 'grenze', 'INTEGER']]);
	assert.ok(voll.endLine > voll.line);
	assert.strictEqual(prog.children.find((c) => c.name === 'lese_zaehler').detail, '() : INTEGER FROM zaehlib');
	assert.strictEqual(prog.children.find((c) => c.name === 'REG_ZAEHLER').detail, '= 10');
});

test('ktrans mit robot.ini (Systemvariablen von Optionen wie ArcTool)', () => {
	const ini = '[WinOLPC_Util]\r\nRobot=\\C\\Users\\x\\Documents\\My Workcells\\Zelle\\Robot_1\r\nVersion=V9.40-1\r\nPath=C:\\Program Files (x86)\\FANUC\\WinOLPC\\Versions\\V940-1\\bin\r\nSupport=C:\\Users\\x\\Documents\\My Workcells\\Zelle\\Robot_1\\support\r\n';
	assert.deepStrictEqual(K.parseRobotIni(ini).version, 'V9.40-1');
	assert.strictEqual(K.parseRobotIni('[Andere]\nVersion=1'), undefined);

	assert.ok(K.hasConfigArg('/ver V9.30-1 /config C:\\robot.ini'));
	assert.ok(!K.hasConfigArg('/ver V9.30-1'));

	assert.ok(K.usesSystemVariables('BEGIN\n  IF $AWSCFG.$TOT_ARC_EQ > 0 THEN'));
	assert.ok(!K.usesSystemVariables("BEGIN\n  WRITE('$ kostet') -- $AWSCFG im Kommentar"));

	const ktrans = 'C:\\Program Files (x86)\\FANUC\\WinOLPC\\bin\\ktrans.exe';
	const robot = 'C:\\Users\\x\\Documents\\My Workcells\\Zelle\\Robot_1\\robot.ini';
	assert.strictEqual(K.ktransCommandLine(ktrans, 'FRONIUS.kl', 'FRONIUS.pc', '', robot, true),
		`& "${ktrans}" FRONIUS.kl /config "${robot}"`, 'mit robot.ini ohne Zieldatei (sonst Kopierfehler 32)');
	assert.strictEqual(K.ktransCommandLine('ktrans', 'a.kl', 'a.pc', '/config x.ini', robot, false), 'ktrans a.kl /config x.ini', 'eigenes /config gewinnt');
	assert.strictEqual(K.ktransCommandLine('ktrans', 'a.kl', 'a.pc', '', undefined, true), 'ktrans a.kl a.pc');

	assert.deepStrictEqual(K.robotIniSearchDirs('D:\\Projekte\\Zelle\\07_Fanuc\\Karel', ['D:\\Projekte\\Zelle']),
		['D:\\Projekte\\Zelle\\07_Fanuc\\Karel', 'D:\\Projekte\\Zelle\\07_Fanuc', 'D:\\Projekte\\Zelle']);
	assert.deepStrictEqual(K.robotIniSearchDirs('/w/a/b', ['/w']), ['/w/a/b', '/w/a', '/w']);
	assert.deepStrictEqual(K.robotIniSearchDirs('/x/a', ['/w']), ['/x/a'], 'außerhalb des Arbeitsbereichs nur der eigene Ordner');
});
