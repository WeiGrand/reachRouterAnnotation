////////////////////////////////////////////////////////////////////////////////
// createHistory(source) - wraps a history source
// history 方法封装

/**
 * 通过 `源` 返回 `location`
 * @param source
 * @returns {{state: *, key: (*|string)}}
 */
let getLocation = source => {
  return {
    ...source.location,
    state: source.history.state,
    key: (source.history.state && source.history.state.key) || "initial"
  };
};

/**
 * 生成 history 对象
 * @param source
 * @param options
 * @returns {*}
 */
let createHistory = (source, options) => { // options 并没有用到...
  let listeners = []; // 事件监听
  let location = getLocation(source);
  let transitioning = false;
  let resolveTransition = () => {};

  return {
    get location() {
      return location;
    },

    get transitioning() {
      return transitioning;
    },

    _onTransitionComplete() {
      transitioning = false;
      resolveTransition();
    },

    listen(listener) {
      listeners.push(listener);

      let popstateListener = () => {
        location = getLocation(source); // 监听 popstate 更新 location
        listener();
      };

      source.addEventListener("popstate", popstateListener);

      // 事件监听的实现一般都会返回一个移除监听事件方法
      return () => {
        source.removeEventListener("popstate", popstateListener);
        listeners = listeners.filter(fn => fn !== listener);
      };
    },

    /**
     * pushState 和 replaceState 的封装
     * @param to
     * @param state
     * @param replace
     * @returns {Promise<any>}
     */
    navigate(to, { state, replace = false } = {}) {
      state = { ...state, key: Date.now() + "" };
      // try...catch iOS Safari limits to 100 pushState calls
      try {
        if (transitioning || replace) {
          source.history.replaceState(state, null, to);
        } else {
          source.history.pushState(state, null, to);
        }
      } catch (e) {
        source.location[replace ? "replace" : "assign"](to);
      }

      location = getLocation(source);
      transitioning = true;
      let transition = new Promise(res => (resolveTransition = res));
      listeners.forEach(fn => fn());
      return transition;
    }
  };
};

////////////////////////////////////////////////////////////////////////////////
// Stores history entries in memory for testing or other platforms like Native

/**
 * 在其她平台中模拟一个 window.location
 * @param initialPathname
 * @returns window.locaion like object
 */
let createMemorySource = (initialPathname = "/") => {
  let index = 0;
  let stack = [{ pathname: initialPathname, search: "" }]; // 对应 location
  let states = []; // 对应 history.state

  return {
    get location() { // location 的 getter
      return stack[index];
    },
    addEventListener(name, fn) {},
    removeEventListener(name, fn) {},
    history: {
      get entries() {
        return stack;
      },
      get index() {
        return index;
      },
      get state() {
        return states[index];
      },
      pushState(state, _, uri) {
        let [pathname, search = ""] = uri.split("?");
        index++;
        stack.push({ pathname, search });
        states.push(state);
      },
      // replaceState 覆盖之前的 index
      replaceState(state, _, uri) {
        let [pathname, search = ""] = uri.split("?");
        stack[index] = { pathname, search };
        states[index] = state;
      }
    }
  };
};

////////////////////////////////////////////////////////////////////////////////
// global history - uses window.history as the source if available, otherwise a
// memory history
/**
 * 判断是否浏览器环境
 * @type {boolean}
 */
let canUseDOM = !!(
  typeof window !== "undefined" &&
  window.document &&
  window.document.createElement
);

/**
 * 根据环境返回 location 源
 * 浏览器环境返回  window
 * 其她平台返回 `内存源`
 * @returns {any}
 */
let getSource = () => {
  return canUseDOM ? window : createMemorySource();
};

let globalHistory = createHistory(getSource());
let { navigate } = globalHistory;

////////////////////////////////////////////////////////////////////////////////
export { globalHistory, navigate, createHistory, createMemorySource };
