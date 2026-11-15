import { processModel } from './process-model.ts';
let finished=false;
process.once('disconnect',()=>{if(!finished)process.exit(1);});

try {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Missing model worker paths');
  const result = await processModel(input, output);
  process.send?.({ result });
} catch (error) {
  process.send?.({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  finished=true;
  process.disconnect?.();
}
