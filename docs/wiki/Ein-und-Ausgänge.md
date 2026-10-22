# Ein- und Ausgänge (E/A)

Die Extension sammelt Kommentare zu den Signalen (`DI`, `DO`, `RI`, `RO`, `GI`, `GO`, `AI`, `AO`, `UI`, `UO`, `SI`, `SO`, `F`, `M` …). Sie zeigt sie im Editor an und nutzt sie bei der Syntaxprüfung.

![E/A-Ansicht und ausgeblendeter Status](images/12-ea-ansicht.png)

## Woher die Kommentare kommen

1. **Aus den Programmen im Workspace:** Referenzen mit Kommentar wie `DO[12:Greifer zu]` oder `DO[6338:ON :PrePosPickupDisk]` werden automatisch eingelesen.
2. **Vom Controller:** In der Ansicht **E/A** auf das Wolken-Symbol klicken (oder Rechtsklick auf einen Controller → **E/A-Liste vom Controller importieren**) und eine Datei wählen, empfohlen `md:IOSTATE.DG`. Die Extension liest daraus Typ, Nummer und Kommentar. **Der aktuelle Signalzustand (ON/OFF, Werte) wird nicht übernommen.**
3. **Aus einer CSV-Datei:** Datei-Symbol in der Ansicht E/A. Format je Zeile `Typ;Nummer;Kommentar` (auch mit `,` oder Tab getrennt, oder `DO[12];Kommentar`); eine Kopfzeile wird übersprungen.

Importierte Listen liegen als JSON unter `.fanuc/io/<Controller>.json` im Workspace und können mit eingecheckt werden. Über `…` → **E/A-Liste als CSV exportieren** lässt sich alles gesammelt, z. B. für Excel, ausgeben.

## Im Editor

- **Hover** über einem Signal zeigt Typ, Kommentar, Quelle und ggf. den im Text gespeicherten Status.
- **Vervollständigung** nach `DO[` schlägt die bekannten Nummern mit Kommentar vor; die Suche findet auch über den Kommentar (z. B. `DO[greif`).
- Ein Klick auf ein Signal in der Ansicht **E/A** sucht alle Verwendungen in den Programmen.

## Status ausblenden

Vom Controller exportierte Programme enthalten manchmal den Signalzustand zum Zeitpunkt des Exports: `WAIT DO[6338:ON :PrePosPickupDisk]=ON`. Das `ON :` ist dabei **nicht** der aktuelle Zustand und verwirrt beim Lesen.

- Standardmäßig wird der Status im Editor **ausgeblendet** (angedeutet durch einen Punkt `·`). In der Zeile mit dem Cursor ist der echte Text sichtbar. Die Datei bleibt unverändert.
- Umschalten über das Augen-Symbol in der Ansicht E/A oder die Einstellung `fanucLs.io.hideStatus`.
- Dauerhaft entfernen: Rechtsklick im Editor → **FANUC: Gespeicherten E/A-Status aus der Datei entfernen**. Aus `DO[6338:ON :PrePosPickupDisk]` wird `DO[6338:PrePosPickupDisk]`.

## Suchen

Der **Trichter** in der Ansicht E/A filtert nach Nummer oder Kommentar, z. B. `Greifer` oder `DO[12`. Passende Typen werden aufgeklappt; der gefüllte Trichter hebt den Filter auf.

## E/A-Kommentare auf den Roboter schreiben

Eine geänderte E/A-Liste lässt sich nicht einfach hochladen: `IOSTATE.DG` ist eine Diagnose-Ausgabe der Steuerung (nur lesbar), die eigentliche E/A-Konfiguration (`DIOCFGSV.IO`) ist binär und nur beim Kaltstart ladbar. Der dokumentierte Weg führt über das KAREL-Built-in `SET_PORT_CMT`:

1. Kommentare in der E/A-Liste pflegen, am einfachsten als CSV (exportieren, in Excel bearbeiten, wieder importieren).
2. In der Ansicht E/A `…` → **E/A-Kommentare auf Roboter übertragen (KAREL)**, Typen und Roboter wählen.
3. Die Extension erzeugt `.fanuc/io/FLIOCMT.KL`. Mit eingerichtetem ktrans (`fanucLs.karel.ktransPath`, aus ROBOGUIDE) → **Kompilieren**, sonst die Datei in ROBOGUIDE kompilieren und `FLIOCMT.PC` in denselben Ordner legen.
4. **FLIOCMT.PC hochladen**, dann am Programmierhandgerät **SELECT → FLIOCMT** auswählen und einmal starten. Das Programm meldet, wie viele Kommentare gesetzt wurden; Fehler stehen in der Alarmliste. Danach kann es gelöscht werden.

Hinweise: Umlaute werden umgeschrieben (`ä` → `ae`), Kommentare auf 24 Zeichen gekürzt (ältere Steuerungen zeigen ggf. nur 16). Unterstützt werden DI, DO, RI, RO, GI, GO, AI, AO, UI, UO, SI, SO, WI, WO und Flags, Merker (`M`) nicht. **Am echten Roboter noch nicht erprobt – bitte zuerst an einer Testzelle oder in ROBOGUIDE ausprobieren.**

## Gültige Bereiche

**Wozu?** Die Bereiche legen nur fest, welche Nummern die **Syntaxprüfung** ohne Warnung akzeptiert, damit Tippfehler wie `DO[1200]` statt `DO[120]` auffallen. Am Roboter ändern sie nichts. Signale aus einer **importierten E/A-Liste gelten immer als gültig**, auch außerhalb des Bereichs; deshalb gibt es z. B. bei `DO[6338]` keine Warnung, wenn das Signal in der Liste steht. Den aktuellen Prüfbereich je Typ zeigt die Ansicht E/A hinter der Typbezeichnung.

Die Syntaxprüfung warnt bei Signalnummern außerhalb der konfigurierten Bereiche (`fanucLs.validation.limits`). Standard ist `1-512` für `DI`/`DO`. Größere Anlagen nutzen oft höhere Nummern, etwa `DO[6338]`. Dafür gibt es drei Wege:

- **E/A-Liste importieren:** Alle Signale aus einer importierten Liste gelten automatisch als gültig.
- **Quick Fix** an der Warnung (`Strg+.`) → **Gültige Bereiche für DO bearbeiten …**, oder das Stift-Symbol am Typ in der Ansicht E/A. Schlägt den passenden Tausenderblock vor, z. B. `1-512, 6001-7000`. Gespeichert wird in den **Benutzereinstellungen**, der Bereich gilt also dauerhaft für alle Ordner und auch für Programme, die direkt vom Roboter geöffnet werden.
- **Von Hand** in den Einstellungen, mehrere Bereiche als Text:

```jsonc
"fanucLs.validation.limits": {
  "DI": "1-512, 4001-5000",
  "DO": "1-512, 6001-7000",
  "R": 200
}
```

Eine Zahl `n` bedeutet `1..n`, `0` schaltet die Prüfung für den Typ ab.
