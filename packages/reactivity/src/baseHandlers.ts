import {
  type Target,
  isReadonly,
  isShallow,
  reactive,
  reactiveMap,
  readonly,
  readonlyMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  toRaw,
} from './reactive'
import { arrayInstrumentations } from './arrayInstrumentations'
import { ReactiveFlags, TrackOpTypes, TriggerOpTypes } from './constants'
import { ITERATE_KEY, track, trigger } from './dep'
import {
  hasChanged,
  hasOwn,
  isArray,
  isIntegerKey,
  isObject,
  isSymbol,
  makeMap,
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

const isNonTrackableKeys = /*@__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /*@__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    // ios10.x Object.getOwnPropertyNames(Symbol) can enumerate 'arguments' and 'caller'
    // but accessing them on Symbol leads to TypeError because Symbol is a strict mode
    // function
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => Symbol[key as keyof SymbolConstructor])
    .filter(isSymbol),
)

/**
 * 重写 hasOwnProperty 方法，是为了去重新收集依赖
 * @param this
 * @param key
 * @returns
 */
function hasOwnProperty(this: object, key: unknown) {
  // #10455 hasOwnProperty may be called with non-string values
  if (!isSymbol(key)) key = String(key)
  const obj = toRaw(this)
  track(obj, TrackOpTypes.HAS, key)
  return obj.hasOwnProperty(key as string)
}

/**
 *  基础的响应式处理程序，用于创建可读写的响应式对象
 */
class BaseReactiveHandler implements ProxyHandler<Target> {
  constructor(
    /** 是否只读 */
    protected readonly _isReadonly = false,
    /** 是否浅响应式 */
    protected readonly _isShallow = false,
  ) {}
  /**
   * 获取属性
   * @param target 目标对象
   * @param key 属性键
   * @param receiver 接收者对象
   * @returns 属性值
   */
  get(target: Target, key: string | symbol, receiver: object): any {
    /** 跳过响应式转换 */
    if (key === ReactiveFlags.SKIP) return target[ReactiveFlags.SKIP]

    const isReadonly = this._isReadonly,
      isShallow = this._isShallow
    /** 是否是响应式对象 */
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
      /** 是否是只读对象 */
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
      /** 是否是浅对象 */
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      return isShallow
      /** 是否是原始对象 */
    } else if (key === ReactiveFlags.RAW) {
      if (
        receiver ===
          (isReadonly
            ? isShallow
              ? shallowReadonlyMap
              : readonlyMap
            : isShallow
              ? shallowReactiveMap
              : reactiveMap
          ).get(target) ||
        // receiver is not the reactive proxy, but has the same prototype
        // this means the receiver is a user proxy of the reactive proxy
        /**  如果 receiver 不是原始代理，但与 target 有相同的原型，说明 receiver 是用户在响应式代理基础上创建的代理 */
        /**
         *  const reactiveObj = reactive({ count: 1 })
            const userProxy = new Proxy(reactiveObj, {
              get(target, key, receiver) {
                // 这里访问 reactiveObj[ReactiveFlags.RAW]
                // 但 receiver 是 userProxy 而不是 reactiveObj
                return Reflect.get(target, key, receiver)
              }
            })
         */
        Object.getPrototypeOf(target) === Object.getPrototypeOf(receiver)
      ) {
        return target
      }
      // early return undefined
      return
    }

    const targetIsArray = isArray(target)

    if (!isReadonly) {
      let fn: Function | undefined
      /** 
       * 检查目标对象是否是数组 (targetIsArray)
         检查访问的属性是否在 arrayInstrumentations 中定义
         Proxy只能拦截“属性级别”的读写，而原生数组方法内部的迭代、比较、长度处理等属于内置算法，行为不可控；需要包一层让这些方法以“可控且可追踪”的方式运行
         重新定义数组方法：
         1、返回值需要保持响应式语义：读方法返回的新数组或元素在非浅响应场景下应继续是响应式；原生方法不会帮你包装，改造后在必要处用 toReactive 包装。
         2、兼容用户扩展：若用户自定义或覆盖了数组方法，改造逻辑会尊重原实现，仅在必要时对参数/返回值做包装，不破坏原行为
         3、长度变更会导致无限循环或抖动：原生 push / splice 会读写 length ，副作用若依赖 length 会被反复收集/触发；改造后在这些方法里暂停追踪并批处理，避免循环
         4、身份敏感比较会误判： includes / indexOf 与代理值做 === 时常得不到期望结果；改造后失败时用 toRaw 重试，桥接“代理 vs 原始”的身份差异。
       */
      if (targetIsArray && (fn = arrayInstrumentations[key])) {
        return fn
      }
      /** 检查访问的属性是否是对象的自有属性 */
      if (key === 'hasOwnProperty') {
        return hasOwnProperty
      }
    }
    /**
     * 调用 Reflect.get 方法获取属性值
     * 访问器的 this 正确（尤其在多层代理、用户代理场景）。
     * @param target 目标对象
     * @param key 属性键
     * @param receiver 接收者对象
     * @returns 属性值
     */
    const res = Reflect.get(
      target,
      key,
      // if this is a proxy wrapping a ref, return methods using the raw ref
      // as receiver so that we don't have to call `toRaw` on the ref in all
      // its class methods
      isRef(target) ? target : receiver,
    )
    /**
     * 跳过不可追踪的属性
     * 跳过 Symbol 属性
     * 跳过内置 Symbol 属性
     * 或者是被标记为“不可追踪”的属性 如 __proto__ 、 __v_isRef 、 __isVue
     */
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }
    /** 如果不是仅读属性 */
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }
    /** 如果是浅响应式对象 */
    if (isShallow) {
      return res
    }
    /** 如果是 ref 对象 */
    if (isRef(res)) {
      // ref unwrapping - skip unwrap for Array + integer key.
      /** 但如果目标是“数组”且键是“整数索引”（如 arr[0] ），就“跳过解包”，直接返回 ref 本身。 */
      const value = targetIsArray && isIntegerKey(key) ? res : res.value
      return isReadonly && isObject(value) ? readonly(value) : value
    }

    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

class MutableReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(false, isShallow)
  }

  set(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
    value: unknown,
    receiver: object,
  ): boolean {
    let oldValue = target[key]
    if (!this._isShallow) {
      const isOldValueReadonly = isReadonly(oldValue)
      if (!isShallow(value) && !isReadonly(value)) {
        oldValue = toRaw(oldValue)
        value = toRaw(value)
      }
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        if (isOldValueReadonly) {
          if (__DEV__) {
            warn(
              `Set operation on key "${String(key)}" failed: target is readonly.`,
              target[key],
            )
          }
          return true
        } else {
          oldValue.value = value
          return true
        }
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    const result = Reflect.set(
      target,
      key,
      value,
      isRef(target) ? target : receiver,
    )
    // don't trigger if target is something up in the prototype chain of original
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }

  deleteProperty(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
  ): boolean {
    const hadKey = hasOwn(target, key)
    const oldValue = target[key]
    const result = Reflect.deleteProperty(target, key)
    if (result && hadKey) {
      trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
    }
    return result
  }

  has(target: Record<string | symbol, unknown>, key: string | symbol): boolean {
    const result = Reflect.has(target, key)
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      track(target, TrackOpTypes.HAS, key)
    }
    return result
  }

  ownKeys(target: Record<string | symbol, unknown>): (string | symbol)[] {
    track(
      target,
      TrackOpTypes.ITERATE,
      isArray(target) ? 'length' : ITERATE_KEY,
    )
    return Reflect.ownKeys(target)
  }
}

class ReadonlyReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(true, isShallow)
  }

  set(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }

  deleteProperty(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }
}

/**
 *  基础的响应式处理程序，用于创建可读写的响应式对象
 */
export const mutableHandlers: ProxyHandler<object> =
  /*@__PURE__*/ new MutableReactiveHandler()

export const readonlyHandlers: ProxyHandler<object> =
  /*@__PURE__*/ new ReadonlyReactiveHandler()

export const shallowReactiveHandlers: MutableReactiveHandler =
  /*@__PURE__*/ new MutableReactiveHandler(true)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers: ReadonlyReactiveHandler =
  /*@__PURE__*/ new ReadonlyReactiveHandler(true)
