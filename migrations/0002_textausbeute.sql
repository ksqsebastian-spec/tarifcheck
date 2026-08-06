-- Wieviel lesbarer Text bei der Umwandlung tatsaechlich herauskam.
--
-- Noetig, weil die Umwandlung stillschweigend leer ausgehen kann: Workers AI
-- meldet fuer manche PDFs "format: markdown" ohne Fehler und liefert doch nur
-- Metadaten und leere Seitenmarken. Betroffen ist unter anderem der BRTV von
-- SOKA-BAU. Ohne dieses Feld gaebe der MCP das Dokument als vorhanden aus,
-- und niemand wuerde merken, dass darin nichts steht.
ALTER TABLE versionen ADD COLUMN text_zeichen INTEGER;
