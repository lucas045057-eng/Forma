import { parseProviderJson } from './provider-json.ts';

export class AssetError extends Error {
  readonly code: string;
  readonly status: number;
  /** For submission paths: blocked before POST, explicitly rejected, or genuinely unknown. */
  readonly classification?: 'blocked' | 'rejected' | 'unknown';
  constructor(code: string, message: string, status = 400, classification?: 'blocked' | 'rejected' | 'unknown') {
    super(message); this.name = 'AssetError'; this.code = code; this.status = status; this.classification = classification;
  }
}
export type GenerationInput = { prompt?: string; img?: string; version: 'G1' | 'G1-Turbo' };
export interface RemoteTask { status: number; outputs?: { content: string }[] }

const LOOPBACK_GATEWAYS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export class Lux3DClient {
  readonly base: string;
  private readonly key: string;
  get configured(){return !!this.key;}
  /** The official single-service gateway is api.aholo.cn; legacy cloud hosts stay explicit, while loopback mocks are local test endpoints. */
  get activeGateway(){return new URL(this.base).hostname;}
  get legacyGateway(){const host=this.activeGateway.toLowerCase();return host!=='api.aholo.cn'&&!LOOPBACK_GATEWAYS.has(host);}
  constructor(options: { base?: string; key?: string }) {
    this.base = (options.base ?? 'https://api.aholo3d.cn').replace(/\/$/, '');
    const url = new URL(this.base);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
      throw new Error('Invalid LUX3D_BASE: HTTPS required except for loopback mock');
    }
    this.key = options.key ?? '';
  }
  private async request<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (!this.key) throw new AssetError('MISSING_KEY', '后端尚未配置 LUX3D_API_KEY');
    let response: Response;
    try {
      response = await fetch(`${this.base}/lux3d/v1/${route}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: this.key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), redirect: 'error',
      });
    } catch { throw new AssetError('UPSTREAM_UNAVAILABLE', 'Lux3D 请求未确认，请查询已有任务，不要自动重复生成'); }
    if (!response.ok) throw new AssetError('UPSTREAM_HTTP', `Lux3D 返回 HTTP ${response.status}`);
    let envelope: { c?: unknown; d?: T };
    try { envelope = parseProviderJson(await response.text()) as typeof envelope; }
    catch { throw new AssetError('UPSTREAM_FORMAT', 'Lux3D 返回无法解析的数据'); }
    if (String(envelope.c) !== '0' || envelope.d === undefined) {
      throw new AssetError('UPSTREAM_REJECTED', 'Lux3D 未接受请求，请核对参数、额度及并发任务');
    }
    return envelope.d;
  }
  private async create(route: string, body: unknown, signal?: AbortSignal): Promise<string> {
    const id = String(await this.request<unknown>(route, body, signal));
    if (!/^\d{1,20}$/.test(id)) throw new AssetError('UPSTREAM_FORMAT', 'Lux3D 未返回有效任务编号');
    return id;
  }
  createTextTo3d(input: GenerationInput, signal?: AbortSignal) {
    return this.create('generate/text-to-3d/task/create', { prompt: input.prompt, version: input.version, outputFormat: ['glb'], enablePbr: true }, signal);
  }
  createImgTo3d(input: GenerationInput, signal?: AbortSignal) {
    return this.create('generate/img-to-3d/task/create', { img: input.img, version: input.version, outputFormat: ['glb'], enablePbr: true }, signal);
  }
  createPartSplit(input: { glbUrl: string }) {
    return this.create('part-split/task/create', input);
  }
  async getTask(taskId: string, signal?: AbortSignal): Promise<RemoteTask> {
    if (!/^\d{1,20}$/.test(taskId)) throw new AssetError('INVALID_TASK', '任务编号必须为数字');
    const task = await this.request<RemoteTask>(`generate/task/get?taskid=${taskId}`, undefined, signal);
    if (!task || typeof task.status !== 'number') throw new AssetError('UPSTREAM_FORMAT', 'Lux3D 任务状态格式错误');
    return task;
  }
  listTasks() { return this.request<unknown>('generate/task/list'); }

  async providerRequest(input:{route:string;method?:'GET'|'POST';body?:unknown;form?:FormData;headers?:Record<string,string>;signal?:AbortSignal}):Promise<string>{
    input.signal?.throwIfAborted();
    if(input.route!=='/asset/v1/token'&&!/^\/lux3d\/v1\/[a-z0-9/-]+(?:\?[a-zA-Z0-9=&%_-]+)?$/.test(input.route))throw new AssetError('INVALID_PROVIDER_ROUTE','只允许预定义的Lux3D服务路径',400,'blocked');
    if(!this.key)throw new AssetError('MISSING_KEY','后端尚未配置 LUX3D_API_KEY',503,'blocked');
    let response:Response;
    try{
      response=await fetch(new URL(input.route,`${this.base}/`),{method:input.method??(input.body!==undefined||input.form?'POST':'GET'),headers:{Authorization:this.key,...(input.body!==undefined?{'Content-Type':'application/json'}:{}),...input.headers},body:input.form??(input.body!==undefined?JSON.stringify(input.body):undefined),signal:input.signal?AbortSignal.any([input.signal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000),redirect:'error'});
    }catch{throw new AssetError('UPSTREAM_UNAVAILABLE','云端请求结果未知，请先恢复已有任务，不要重复创建',502,'unknown');}
    let text:string;
    try{
      if(!response.body)throw new Error('Missing response body');const reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
      try{for(;;){const result=await reader.read();if(result.done)break;bytes+=result.value.byteLength;if(bytes>1_048_576){await reader.cancel();throw new Error('Provider response too large');}chunks.push(result.value);}text=Buffer.concat(chunks).toString('utf8');}finally{reader.releaseLock();}
    }catch{throw new AssetError('UPSTREAM_UNAVAILABLE','云端响应读取失败或超限，提交结果未知',502,'unknown');}
    let envelope:Record<string,unknown>;try{envelope=parseProviderJson(text) as Record<string,unknown>;}catch{throw new AssetError('UPSTREAM_FORMAT','云端返回无法解析的数据，提交结果未知',502,'unknown');}
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))throw new AssetError('UPSTREAM_FORMAT','云端响应必须是JSON对象，提交结果未知',502,'unknown');
    if(!response.ok){
      if(response.status===400)throw new AssetError('UPSTREAM_REJECTED','Lux3D明确拒绝了本次请求，请核对参数、权限或额度',400,'rejected');
      if(response.status===401)throw new AssetError('UPSTREAM_AUTH','Lux3D鉴权失败，未接受本次请求',403,'rejected');
      if(response.status===403)throw new AssetError('UPSTREAM_FORBIDDEN','Lux3D返回403；规范未保证未受理，本次结果只能按未知处理',502,'unknown');
      throw new AssetError('UPSTREAM_HTTP',`Lux3D返回HTTP ${response.status}，提交结果未知`,502,'unknown');
    }
    if(input.route!=='/asset/v1/token'){
      if(envelope.c===undefined||envelope.c===null)throw new AssetError('UPSTREAM_FORMAT','Lux3D成功响应缺少状态码，结果未知',502,'unknown');
      if(String(envelope.c)!=='0')throw new AssetError('UPSTREAM_REJECTED','Lux3D未接受请求，请核对参数、权限、额度及并发限制',400,'rejected');
    }
    return text;
  }
  async createProviderTask(route:string,body:unknown,signal?:AbortSignal):Promise<string>{
    const text=await this.providerRequest({route,method:'POST',body,signal});
    const envelope=parseProviderJson(text) as {d?:unknown};const id=typeof envelope.d==='string'?envelope.d:typeof envelope.d==='number'&&Number.isSafeInteger(envelope.d)?String(envelope.d):undefined;
    if(!id||!/^[1-9]\d{0,18}$/.test(id)||BigInt(id)>9223372036854775807n)throw new AssetError('UPSTREAM_FORMAT','云端未返回有效任务编号；提交状态需进一步核实',502);
    return id;
  }
  async getProviderTask(providerTaskId:string,signal?:AbortSignal):Promise<RemoteTask>{
    if(!/^\d{1,20}$/.test(providerTaskId))throw new AssetError('INVALID_TASK','云端任务编号无效',400,'blocked');
    const text=await this.providerRequest({route:`/lux3d/v1/generate/task/get?taskid=${encodeURIComponent(providerTaskId)}`,signal});
    const raw=parseProviderJson(text) as {d?:{status?:unknown;outputs?:unknown}};
    if(!raw.d||typeof raw.d.status!=='number'||![0,1,3,4,6].includes(raw.d.status)||(raw.d.outputs!==undefined&&(!Array.isArray(raw.d.outputs)||raw.d.outputs.some(item=>!item||typeof item!=='object'||(item.content!==null&&item.content!==undefined&&typeof item.content!=='string')))))throw new AssetError('UPSTREAM_FORMAT','云端任务状态格式错误',502,'unknown');
    return {status:raw.d.status,outputs:(raw.d.outputs as Array<{content?:string|null}>|undefined)?.map(item=>({content:typeof item.content==='string'?item.content:''}))};
  }
  async listProviderTasks(input:{page?:number;pagesize?:number;status?:number;starttime?:string|number;endtime?:string|number}= {},signal?:AbortSignal):Promise<Array<{providerTaskId:string;status:number;created?:string}>>{
    const page=input.page??1,pagesize=input.pagesize??100;
    if(!Number.isInteger(page)||page<1||page>100||!Number.isInteger(pagesize)||pagesize<1||pagesize>100)throw new AssetError('INVALID_TASK_QUERY','任务历史分页无效',400,'blocked');
    if(input.status!==undefined&&![0,1,3,4].includes(input.status))throw new AssetError('INVALID_TASK_QUERY','任务状态筛选无效',400,'blocked');
    const query=new URLSearchParams({page:String(page),pagesize:String(pagesize)});
    if(input.status!==undefined)query.set('status',String(input.status));
    for(const [name,value]of [['starttime',input.starttime],['endtime',input.endtime]] as const){
      if(value===undefined)continue;
      const text=String(value);
      if(!/^\d{1,19}$/.test(text)||BigInt(text)>9223372036854775807n)throw new AssetError('INVALID_TASK_QUERY','任务时间筛选无效',400,'blocked');
      query.set(name,text);
    }
    const text=await this.providerRequest({route:`/lux3d/v1/generate/task/list?${query.toString()}`,signal});
    const raw=parseProviderJson(text) as {d?:{items?:Array<{taskId:unknown;status:unknown;created?:unknown}>}};
    if(!raw.d||!Array.isArray(raw.d.items)||raw.d.items.some(item=>!item||typeof item.status!=='number'||![0,1,3,4,6].includes(item.status)||(item.created!==undefined&&(typeof item.created!=='string'&&typeof item.created!=='number'))))throw new AssetError('UPSTREAM_FORMAT','云端历史格式错误',502,'unknown');
    return raw.d.items.map(item=>({providerTaskId:String(item.taskId),status:Number(item.status),...(item.created!==undefined?{created:String(item.created)}:{})}));
  }
  async getUploadCredentials(signal?:AbortSignal):Promise<{token:string;globalDomain:string;blockSize:number}>{
    const text=await this.providerRequest({route:'/asset/v1/token',signal});
    const raw=parseProviderJson(text) as {ousToken?:unknown;globalDomain?:unknown;blockSize?:unknown};
    const blockSize=typeof raw.blockSize==='string'&&/^\d{1,19}$/.test(raw.blockSize)?Number(raw.blockSize):raw.blockSize;
    if(typeof raw.ousToken!=='string'||!raw.ousToken||typeof raw.globalDomain!=='string'||typeof blockSize!=='number'||!Number.isSafeInteger(blockSize)||blockSize<1||blockSize>100*1024*1024)throw new AssetError('UPSTREAM_FORMAT','上传凭证格式错误',502,'unknown');
    let domain:URL;try{domain=new URL(raw.globalDomain);}catch{throw new AssetError('UNSAFE_UPLOAD_DOMAIN','上传凭证目的域无效',400,'blocked');}
    const base=new URL(this.base),loopback=[ '127.0.0.1','localhost','[::1]' ].includes(base.hostname)&&domain.origin===base.origin&&domain.protocol==='http:';
    if((domain.protocol!=='https:'&&!loopback)||domain.username||domain.password||domain.pathname!=='/'||domain.search||domain.hash||(!loopback&&domain.port))throw new AssetError('UNSAFE_UPLOAD_DOMAIN','上传凭证目的域不是纯HTTPS源（本地mock除外）',400,'blocked');
    return {token:raw.ousToken,globalDomain:domain.origin,blockSize};
  }
}
