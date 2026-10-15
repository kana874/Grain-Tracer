// Debounce edits into one learning round. Never run concurrently.
export function createLearningCoordinator({ready, run, onStatus=()=>{}, debounceMs=1800, autoRun=true}) {
  let timer=null, running=false, changedWhileRunning=false, disposed=false;
  const cancel=()=>{if(timer!=null)clearTimeout(timer);timer=null;};
  function schedule(delay=debounceMs) {
    cancel();
    if(disposed)return;
    timer=setTimeout(()=>{timer=null;void flush();},delay);
  }
  async function flush({manual=false}={}) {
    cancel();
    if(disposed)return false;
    if(running){changedWhileRunning=true;return false;}
    if(!ready()){onStatus("waiting");return false;}
    running=true;
    changedWhileRunning=false;
    onStatus("training");
    try {
      await run({automatic:!manual});
      return true;
    } catch(error){
      onStatus("failed",error);
      return false;
    } finally {
      running=false;
      if(changedWhileRunning&&!disposed&&autoRun)schedule();
    }
  }
  return {
    changed(){if(!disposed){changedWhileRunning ||= running;if(autoRun)schedule();else cancel();onStatus("pending");}},
    flush,cancel,
    dispose(){disposed=true;cancel();},
    get running(){return running;},
  };
}
