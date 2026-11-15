import {createContext,useContext,type ReactNode} from 'react';
import type {M2State} from '../m2-state.ts';
interface TestCenter {state:M2State;syncReady:boolean;status:'connected'|'reconnecting';locked:(keys:string[])=>boolean;acquire:(keys:string[])=>symbol|undefined;awaiting:(token:symbol)=>void;reload:()=>Promise<void>}
const Context=createContext<TestCenter|null>(null);
export function CenterFixture({value,children}:{value:TestCenter;children:ReactNode}){return <Context.Provider value={value}>{children}</Context.Provider>;}
export function useEventCenter(){const value=useContext(Context);if(!value)throw new Error('Test center missing');return value;}
