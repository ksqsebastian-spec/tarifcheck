-- Datumsangaben, die woertlich im Dokument stehen.
--
-- Noetig, weil das gepflegte Feld dokumente.gueltig_ab bei praktisch allen
-- Dokumenten leer ist. Der Vorbehalt "kein Gueltigkeitsdatum hinterlegt"
-- erschien damit bei jedem einzelnen Treffer - und ein Hinweis, der immer
-- dasteht, wird ueberlesen. Er war Rauschen statt Warnung.
--
-- Hier steht kein geratenes Datum, sondern ein Zitat samt Fundstelle.
-- Beurteilen muss es, wer die Auskunft liest.
ALTER TABLE versionen ADD COLUMN datum_funde TEXT;
