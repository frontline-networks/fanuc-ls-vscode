# Befehle

Alle Befehle sind über die Befehlspalette (`F1` oder `Strg+Umschalt+P`) mit dem Präfix **FANUC:** erreichbar:

![Befehlspalette](images/09-befehle.png)

| Befehl | Wirkung |
|---|---|
| FANUC: Neues TP-Programm anlegen | fragt den Namen ab und öffnet ein neues, ungespeichertes Listing |
| FANUC: Syntax prüfen | startet die Prüfung für die aktuelle Datei |
| FANUC: Zeilennummern neu nummerieren | nummeriert `/MN` durch, aktualisiert `LINE_COUNT` und `MODIFIED` |
| FANUC: LINE_COUNT im ATTR-Block korrigieren | setzt nur `LINE_COUNT` |
| FANUC: Controller hinzufügen | Assistent für eine neue Steuerung |
| FANUC: Passwort hinterlegen | FTP-Passwort im SecretStorage speichern |
| FANUC: Aktualisieren | Controller-Ansicht neu laden |
| FANUC: Aktuelle Datei auf Controller laden | Upload der offenen Datei |
| FANUC: Mit Controller vergleichen | Diff zwischen offener Datei und Steuerung |
| FANUC: Controller klonen / Klon aktualisieren | Geräte einer Steuerung in einen lokalen Ordner laden |
| FANUC: Klon: Änderungen anzeigen | geänderte, neue und gelöschte Dateien im Klon |
| FANUC: Klon: Änderungen auf Controller übertragen | geänderte Dateien hochladen, mit Konfliktprüfung |
| FANUC: FTP-Protokoll anzeigen | Ausgabekanal *FANUC FTP* öffnen |
| FANUC: Filtern / Suchen | Dateien im Controller-Baum nach Typ und Name filtern |
| FANUC: Filter aufheben | alle Dateien wieder anzeigen |
| FANUC: Klon: Änderungsbericht erstellen | Bericht, was beim Übertragen auf dem Roboter geändert würde |
| FANUC: E/A suchen / filtern | E/A-Liste nach Nummer oder Kommentar filtern |
| FANUC: E/A-Filter aufheben | alle Signale wieder anzeigen |
| FANUC: In FANUC-Doku suchen | eigene Handbücher durchsuchen, siehe [[FANUC-Doku]] |
| FANUC: In FANUC-Doku nachschlagen | Befehl unter dem Cursor nachschlagen (auch per Rechtsklick) |
| FANUC: Doku-Ordner festlegen | Ordner mit Handbüchern wählen |
| FANUC: Doku neu einlesen | Handbücher neu einlesen |
| FANUC: E/A-Kommentare auf Roboter übertragen (KAREL) | KAREL-Programm erzeugen, das die Kommentare am Roboter setzt |

Weitere Befehle stehen nur im Kontextmenü der Controller-Ansicht zur Verfügung, siehe [[Controller und FTP]].

Die Assistenten der [[Schweißer-Oberfläche]] stehen unter dem Präfix **FANUC Schweißen:** (Programm holen, laden, sichern, Schweißgeschwindigkeit ändern, spiegeln, prüfen, Roboter einrichten).
