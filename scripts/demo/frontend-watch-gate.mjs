export function createFrontendWatchGate(){
 let closing=false;
 return {
  get closing(){return closing;},
  seal(){closing=true;},
  attach(watcher){
   const add=watcher.add;
   watcher.add=function(...paths){
    if(closing)return this;
    return Reflect.apply(add,this,paths);
   };
   return watcher;
  }
 };
}
