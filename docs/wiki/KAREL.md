# KAREL

Neben TP-Programmen (`.ls`) unterstützt die Extension auch **KAREL-Quelltexte** (`.kl`). Dateien ohne Endung werden erkannt, wenn die erste Zeile mit `PROGRAM` beginnt. Unten rechts steht dann **FANUC KAREL**.

![KAREL im Editor mit Outline](images/13-karel.png)

## Funktionen

- **Syntaxhighlighting:**
  - Schlüsselwörter, Datentypen (`INTEGER`, `REAL`, `STRING`, `XYZWPR`, `JOINTPOS`, …) und Direktiven (`%COMMENT`, `%NOLOCKGROUP`, `%INCLUDE`, …)
  - Systemvariablen (`$…`) und E/A-Arrays (`DIN[ ]`, `DOUT[ ]`, `GIN[ ]`, …)
  - wichtige Built-ins (`GET_REG`, `SET_INT_REG`, `GET_POS_REG`, `POST_ERR`, `CNV_INT_STR`, …) sowie Kommentare `--` und Zeichenketten `'…'`
- **Outline:** Programm mit Konstanten, Typen, Variablen und Routinen (inkl. Parameter und Rückgabetyp); externe Routinen (`FROM …`) werden gesondert angezeigt.
- **Einrückung und Faltung** für `BEGIN`/`END`, `IF`/`ENDIF`, `FOR`/`ENDFOR`, `WHILE`/`ENDWHILE`, `REPEAT`/`UNTIL`, `SELECT`/`ENDSELECT`, `CONDITION`/`ENDCONDITION`, `STRUCTURE`/`ENDSTRUCTURE`.
- **Snippets:**

| Kürzel | Ergebnis |
|---|---|
| `program` | Programmgerüst mit Direktiven, `CONST`, `VAR`, `BEGIN`/`END` |
| `routine` / `function` / `routinefrom` | Prozedur, Funktion mit Rückgabewert, externe Routine |
| `if` `ifelse` `for` `while` `repeat` `select` | Kontrollstrukturen |
| `condition` | Condition Handler mit `WHEN … DO` und `ENABLE` |
| `structure` | Strukturtyp |
| `write` `read` | Ausgabe/Eingabe am Teach Pendant |
| `getreg` `setreg` `getposreg` `setposreg` | Zahlen- und Positionsregister |
| `dout` `waitdin` `delay` | E/A und Warten |
| `posterr` `chkstatus` | Fehlermeldung, Statusprüfung |
| `include` | `%INCLUDE` |

- **Übertragen:** `.kl`-Quellen und übersetzte `.pc`-Programme lassen sich wie alle Dateien über die [[Controller-Ansicht|Controller-und-FTP]] hoch- und herunterladen. Auf der Steuerung läuft nur die übersetzte `.pc`-Datei.

## Kompilieren mit ktrans

Übersetzt wird mit `ktrans.exe`. Das Programm gehört zu **ROBOGUIDE** und läuft nur unter Windows.

1. In den Einstellungen `fanucLs.karel.ktransPath` auf `ktrans.exe` setzen, z. B. `C:\Program Files (x86)\FANUC\WinOLPC\bin\ktrans.exe`.
2. **`robot.ini` festlegen** (siehe unten), damit ktrans Softwarestand und Optionen des Roboters kennt.
3. Optional `fanucLs.karel.ktransArgs`, z. B. `/ver V9.30-1` für die Softwareversion der Steuerung.
4. In der `.kl`-Datei auf das Zahnrad in der Editor-Titelleiste klicken (**FANUC: KAREL kompilieren**). Die Übersetzung läuft im Terminal *FANUC KAREL*, die `.pc`-Datei entsteht neben der Quelle.

### robot.ini: Systemvariablen von Optionen (z. B. ArcTool)

Ohne `robot.ini` meldet ktrans `Notice: Unable to find 'robot.ini', Using basic KAREL support files` und kennt nur die Grund-Systemvariablen. Programme, die Variablen einer Option verwenden, scheitern dann, z. B. mit ArcTool:

```
 924  IF $AWSCFG.$TOT_ARC_EQ > 0 THEN
               ^ ERROR
Id must be defined before this use.  Id: $AWSCFG
```

Abhilfe: ktrans mit einer `robot.ini` aufrufen (`/config`), die auf einen ROBOGUIDE-Roboter mit demselben Softwarestand und denselben Optionen zeigt. Die `robot.ini` liegt **nicht** fertig in der Zelle, sondern wird mit **`setrobot.exe`** erzeugt (liegt neben `ktrans.exe` in `…\FANUC\WinOLPC\bin`):

1. Kachel **robot.ini wählen** → *Mit setrobot.exe erzeugen* (oder beim Kompilieren *Mit setrobot erzeugen*). Die Extension startet `setrobot.exe` im Ordner der `.kl`-Datei.
2. Im Fenster von setrobot den ROBOGUIDE-Roboter wählen (Zelle mit ArcTool und passendem Softwarestand, z. B. V9.40).
3. setrobot schreibt die `robot.ini` in den Ordner. Danach erneut kompilieren: Die Extension findet sie neben der `.kl`-Datei (oder in einem Elternordner im Arbeitsbereich) und übergibt sie mit `/config`.

Eine vorhandene `robot.ini` lässt sich auch über *Vorhandene robot.ini wählen* oder die Einstellung `fanucLs.karel.robotIni` festlegen.

**Ohne passenden ROBOGUIDE-Roboter:** in ROBOGUIDE selbst kompilieren (die `.kl`-Datei der Zelle hinzufügen und dort übersetzen) oder die Systemvariablen zur Laufzeit lesen, z. B. `GET_VAR(entry, '*SYSTEM*', '$AWSCFG.$TOT_ARC_EQ', anzahl, status)` statt `$AWSCFG.$TOT_ARC_EQ` – das übersetzt auch mit den Grund-Support-Dateien.

Die Befehlszeile sieht dann so aus:

```
& "C:\Program Files (x86)\FANUC\WinOLPC\bin\ktrans.exe" FRONIUS.kl /config "D:\…\Karel\robot.ini"
```

Mit `/config` übersetzt ktrans im `Output`-Ordner des ROBOGUIDE-Roboters und kopiert die `.pc` selbst neben die Quelle. Deshalb steht keine Zieldatei im Befehl: Mit Zieldatei wird die `.pc` zwar korrekt erzeugt, ktrans meldet aber `Copy to/from source directory failed: 32`.

Die Syntax wird bisher nur durch ktrans geprüft; eine eigene KAREL-Syntaxprüfung wie bei TP-Programmen gibt es noch nicht.
