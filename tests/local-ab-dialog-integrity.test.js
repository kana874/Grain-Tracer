import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('local A/B dialog exposes Undo/Redo and independent shortcut handling',async()=>{
  const ui=await readFile(new URL('../src/local-ab-ui.js',import.meta.url),'utf8');
  const app=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
  assert.match(ui,/data-k="undo"/);
  assert.match(ui,/data-k="redo"/);
  assert.match(ui,/reviewUndoRedo\(direction\)/);
  assert.match(ui,/event\.stopPropagation\(\)/);
  assert.match(ui,/el\('undo'\)\.addEventListener/);
  assert.match(ui,/el\('redo'\)\.addEventListener/);
  assert.match(app,/getHistoryState: \(\) => \(\{undo:state\.undoStack\.length,redo:state\.redoStack\.length\}\)/);
  assert.match(app,/onUndo: \(\) =>/);
  assert.match(app,/onRedo: \(\) =>/);
});
test('diagnostic export uses safe serializer and stage-specific error reporting',async()=>{
  const app=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
  assert.match(app,/serializeDiagnosticJson\(report\)/);
  assert.match(app,/diagnosticStage = "診断JSONの直列化"/);
  assert.match(app,/diagnosticStage = "ZIPファイルの組み立て"/);
  assert.match(app,/診断出力エラー（\$\{diagnosticStage\}）/);
});
