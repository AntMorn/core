// using literal strings instead of numbers so that it's easier to inspect
// debugger events

export enum TrackOpTypes {
  /** 获取属性值 (obj.prop) */
  GET = 'get',
  /** 检查属性是否存在 (prop in obj) */
  HAS = 'has',
  /** 遍历对象属性 (for...in, Object.keys()等) */
  ITERATE = 'iterate',
}

export enum TriggerOpTypes {
  SET = 'set',
  ADD = 'add',
  DELETE = 'delete',
  CLEAR = 'clear',
}

export enum ReactiveFlags {
  SKIP = '__v_skip',
  IS_REACTIVE = '__v_isReactive',
  IS_READONLY = '__v_isReadonly',
  IS_SHALLOW = '__v_isShallow',
  RAW = '__v_raw',
  IS_REF = '__v_isRef',
}
