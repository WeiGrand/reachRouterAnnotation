/* eslint-disable jsx-a11y/anchor-has-content */
import React from "react";
import warning from "warning";
import PropTypes from "prop-types";
import invariant from "invariant";
import createContext from "create-react-context";
import { polyfill } from "react-lifecycles-compat";
import ReactDOM from "react-dom";
import {
  startsWith,
  pick,
  resolve,
  match,
  insertParams,
  validateRedirect
} from "./lib/utils";
import {
  globalHistory,
  navigate,
  createHistory,
  createMemorySource
} from "./lib/history";

////////////////////////////////////////////////////////////////////////////////
// React polyfill
// React 16 Fiber 架构新增的方法，用于告诉React，某个任务，是一个 low priority 的任务
let { unstable_deferredUpdates } = ReactDOM;
if (unstable_deferredUpdates === undefined) {
  unstable_deferredUpdates = fn => fn();
}

/**
 * Context API 封装
 * @param name
 * @param defaultValue
 * @returns {Context<any>}
 */
const createNamedContext = (name, defaultValue) => {
  const Ctx = createContext(defaultValue);
  Ctx.Consumer.displayName = `${name}.Consumer`;
  Ctx.Provider.displayName = `${name}.Provider`;
  return Ctx;
};

////////////////////////////////////////////////////////////////////////////////
// Location Context/Provider
let LocationContext = createNamedContext("Location"); // => <LocationContext.Provider> / <LocationContext.Consumer />

// sets up a listener if there isn't one already so apps don't need to be
// wrapped in some top level provider
/**
 * 对应API: https://reach.tech/router/api/Location
 * @param children
 * @returns {*}
 * @constructor
 */
let Location = ({ children }) => (
  // 如果 <LocationContext.Consumer> 是 <LocationContext.Provider value={...}> 的子元素 context 为该 Provider 的 value，否则给她包一个默认的 Provider => LocationProvider 以提供 context({ navigate, location })
  <LocationContext.Consumer>
    {context => // context 提供 navigate 和 location 两个值
      context ? (
        children(context) //
      ) : (
        <LocationProvider>{children}</LocationProvider>
      )
    }
  </LocationContext.Consumer>
);

class LocationProvider extends React.Component {
  static defaultProps = {
    history: globalHistory
  };

  state = {
    context: this.getContext(), // 默认是 globalHistory 的 navigate 和 location
    refs: { unlisten: null }
  };

  getContext() {
    let { props: { history: { navigate, location } } } = this;
    return { navigate, location };
  }

  // React 16 新加入的生命周期，用于捕捉该 Component 的子元素的错误 类似于 try catch 的 catch
  componentDidCatch(error, info) {
    if (isRedirect(error)) {
      let { props: { history: { navigate } } } = this;
      navigate(error.uri, { replace: true });
    } else {
      throw error;
    }
  }

  componentDidUpdate(prevProps, prevState) {
    if (prevState.context.location !== this.state.context.location) {
      this.props.history._onTransitionComplete();
    }
  }

  componentDidMount() {
    let { state: { refs }, props: { history } } = this;
    refs.unlisten = history.listen(() => {
      Promise.resolve().then(() => {
        unstable_deferredUpdates(() => { // 告诉React，这个 setState 任务，是一个 low priority 的任务
          this.setState(() => ({ context: this.getContext() }));
        });
      });
    });
  }

  componentWillUnmount() {
    let { state: { refs } } = this;
    refs.unlisten();
  }

  render() {
    let { state: { context }, props: { children } } = this;
    return (
      <LocationContext.Provider value={context}>
        {typeof children === "function" ? children(context) : children || null}
      </LocationContext.Provider>
    );
  }
}

////////////////////////////////////////////////////////////////////////////////
/**
 * 服务端渲染的 location https://reach.tech/router/api/ServerLocation
 * @param url
 * @param children
 * @returns {*}
 * @constructor
 */
let ServerLocation = ({ url, children }) => (
  <LocationContext.Provider
    value={{
      location: { pathname: url },
      navigate: () => {
        throw new Error("You can't call navigate on the server.");
      }
    }}
  >
    {children}
  </LocationContext.Provider>
);

////////////////////////////////////////////////////////////////////////////////
// Sets baseuri and basepath for nested routers and links

let BaseContext = createNamedContext("Base", { baseuri: "/", basepath: "/" });

////////////////////////////////////////////////////////////////////////////////
// The main event, welcome to the show everybody.
/**
 * 核心组件 Router https://reach.tech/router/api/Router
 * BaseContext => RouteImpl => FocusContext => FocusImpl
 * @param props
 * @returns {*}
 * @constructor
 */
let Router = props => (
  <BaseContext.Consumer>
    {baseContext => ( // 如果不是 <BaseContext.Provider> 的子元素取默认值 { baseuri: "/", basepath: "/" }
      <Location>
        {locationContext => (
          <RouterImpl {...baseContext} {...locationContext} {...props} />
        )}
      </Location>
    )}
  </BaseContext.Consumer>
);

class RouterImpl extends React.PureComponent {
  static defaultProps = {
    primary: true
  };

  render() {
    let {
      location,
      navigate,
      basepath,
      primary,
      children,
      component = "div",
      baseuri,
      ...domProps // 剩余的 props 都是 dom 属性
    } = this.props;
    let routes = React.Children.map(children, createRoute(basepath)); // [{ value, default, path }, ...]
    let { pathname } = location;

    let match = pick(routes, pathname); // 计算出最匹配的组件 { route, uri, params }

    if (match) {
      let { params, uri, route, route: { value: element } } = match;

      // remove the /* from the end for child routes relative paths
      basepath = route.default ? basepath : route.path.replace(/\*$/, "");

      let props = {
        ...params,
        uri,
        location,
        navigate: (to, options) => navigate(resolve(to, uri), options)
      };

      let clone = React.cloneElement(
        element,
        props,
        element.props.children ? (
          <Router primary={primary}>{element.props.children}</Router>
        ) : (
          undefined
        )
      );

      // using 'div' for < 16.3 support
      let FocusWrapper = primary ? FocusHandler : component;
      // don't pass any props to 'div'
      let wrapperProps = primary ? { uri, location, ...domProps } : domProps;

      return (
        <BaseContext.Provider value={{ baseuri: uri, basepath }}>
          <FocusWrapper {...wrapperProps}>{clone}</FocusWrapper>
        </BaseContext.Provider>
      );
    } else {
      // Not sure if we want this, would require index routes at every level
      // warning(
      //   false,
      //   `<Router basepath="${basepath}">\n\nNothing matched:\n\t${
      //     location.pathname
      //   }\n\nPaths checked: \n\t${routes
      //     .map(route => route.path)
      //     .join(
      //       "\n\t"
      //     )}\n\nTo get rid of this warning, add a default NotFound component as child of Router:
      //   \n\tlet NotFound = () => <div>Not Found!</div>
      //   \n\t<Router>\n\t  <NotFound default/>\n\t  {/* ... */}\n\t</Router>`
      // );
      return null;
    }
  }
}

let FocusContext = createNamedContext("Focus");

let FocusHandler = ({ uri, location, ...domProps }) => (
  <FocusContext.Consumer>
    {requestFocus => (
      <FocusHandlerImpl
        {...domProps}
        requestFocus={requestFocus}
        uri={uri}
        location={location}
      />
    )}
  </FocusContext.Consumer>
);

// don't focus on initial render
let initialRender = true;
let focusHandlerCount = 0;

class FocusHandlerImpl extends React.Component {
  state = {};

  /**
   * 这个生命周期会在 render 之前执行 参考：https://reactjs.org/docs/react-component.html#static-getderivedstatefromprops
   * @param nextProps
   * @param prevState
   * @returns {{shouldFocus: boolean}} 返回的 object 会更新组件的 state
   */
  static getDerivedStateFromProps(nextProps, prevState) {
    let initial = prevState.uri == null;
    // 判断是否 focus
    // 初始化 focus
    if (initial) {
      return {
        shouldFocus: true,
        ...nextProps
      };
    } else {
      let myURIChanged = nextProps.uri !== prevState.uri;
      let navigatedUpToMe =
        prevState.location.pathname !== nextProps.location.pathname &&
        nextProps.location.pathname === nextProps.uri; // prev 和 next 的 pathname 不同，切 pathname === uri 的时候（该组件渲染为可见状态） focus
      return {
        shouldFocus: myURIChanged || navigatedUpToMe,
        ...nextProps
      };
    }
  }

  componentDidMount() {
    focusHandlerCount++; // 觉得这步和 componentWillUnmount 那步有点多余，后面再断点看看
    this.focus();
  }

  componentWillUnmount() {
    focusHandlerCount--;
    if (focusHandlerCount === 0) {
      initialRender = true;
    }
  }

  componentDidUpdate(prevProps, prevState) {
    if (prevProps.location !== this.props.location && this.state.shouldFocus) {
      this.focus();
    }
  }

  focus() {
    if (process.env.NODE_ENV === "test") {
      // getting cannot read property focus of null in the tests
      // and that bit of global `initialRender` state causes problems
      // should probably figure it out!
      return;
    }

    let { requestFocus } = this.props;

    if (requestFocus) {
      requestFocus(this.node);
    } else {
      if (initialRender) {
        initialRender = false;
      } else {
        this.node.focus();
      }
    }
  }

  requestFocus = node => {
    if (!this.state.shouldFocus) {
      node.focus();
    }
  };

  render() {
    let {
      children,
      style,
      requestFocus,
      role = "group",
      component: Comp = "div",
      uri,
      location,
      ...domPropsr
    } = this.props;
    return (
      <Comp
        style={{ outline: "none", ...style }}
        tabIndex="-1"
        role={role}
        ref={n => (this.node = n)}
        {...domProps}
      >
        <FocusContext.Provider value={this.requestFocus}>
          {this.props.children}
        </FocusContext.Provider>
      </Comp>
    );
  }
}

// 在较低版本的 React 项目中兼容 getDerivedStateFromProps 这个生命周期
polyfill(FocusHandlerImpl);

let k = () => {};

////////////////////////////////////////////////////////////////////////////////
/**
 * https://reach.tech/router/api/Link
 * @param props
 * @returns {*}
 * @constructor
 */
let Link = props => (
  // 如果作为 Route 子元素 将会得到 BaseContext.Provider 提供的 basepath, baseuri 从而实现 `相对路径`
  <BaseContext.Consumer>
    {({ basepath, baseuri }) => (
      <Location>
        {({ location, navigate }) => {
          let { to, state, replace, getProps = k, ...anchorProps } = props;
          let href = resolve(to, baseuri);
          let isCurrent = location.pathname === href;
          let isPartiallyCurrent = startsWith(location.pathname, href);

          return (
            <a
              aria-current={isCurrent ? "page" : undefined} {/* aria-current 无障碍阅读相关的属性  https://developer.mozilla.org/zh-CN/docs/Web/Accessibility/ARIA */}
              {...anchorProps}
              {...getProps({ isCurrent, isPartiallyCurrent, href, location })}
              href={href}
              onClick={event => {
                if (anchorProps.onClick) anchorProps.onClick(event);
                if (shouldNavigate(event)) { // 如果判断为应该跳转，会阻止默认的跳转行为，而使用 navigate 这个方法跳
                  event.preventDefault();
                  navigate(href, { state, replace });
                }
              }}
            />
          );
        }}
      </Location>
    )}
  </BaseContext.Consumer>
);

////////////////////////////////////////////////////////////////////////////////
// 重定向相关代码
function RedirectRequest(uri) {
  this.uri = uri;
}

/**
 * 判断 error 是否来自 redirect https://reach.tech/router/api/isRedirect
 * @param o Error
 * @returns {boolean}
 */
let isRedirect = o => o instanceof RedirectRequest;

/**
 * 抛出一个 redirect 的 错误 让 Location Provider 捕捉以实现跳转
 * @param to
 */
let redirectTo = to => {
  throw new RedirectRequest(to);
};

class RedirectImpl extends React.Component {
  // Support React < 16 with this hook
  componentDidMount() {
    let {
      props: { navigate, to, from, replace = true, state, noThrow, ...props }
    } = this;
    navigate(insertParams(to, props), { replace, state });
  }

  render() {
    let {
      props: { navigate, to, from, replace, state, noThrow, ...props }
    } = this;
    if (!noThrow) redirectTo(insertParams(to, props));
    return null;
  }
}

let Redirect = props => (
  <Location>
    {locationContext => <RedirectImpl {...locationContext} {...props} />}
  </Location>
);

Redirect.propTypes = {
  from: PropTypes.string,
  to: PropTypes.string.isRequired
};

////////////////////////////////////////////////////////////////////////////////
/**
 * 根据 path 匹配参数 (:item) 的值 https://reach.tech/router/api/Match
 * @param path
 * @param children
 * @returns {*}
 * @constructor
 */
let Match = ({ path, children }) => (
  <BaseContext.Consumer>
    {({ baseuri }) => (
      <Location>
        {({ navigate, location }) => {
          let resolvedPath = resolve(path, baseuri);
          let result = match(resolvedPath, location.pathname);
          return children({
            navigate,
            location,
            match: result
              ? {
                  ...result.params,
                  uri: result.uri,
                  path
                }
              : null
          });
        }}
      </Location>
    )}
  </BaseContext.Consumer>
);

////////////////////////////////////////////////////////////////////////////////
// Junk
/**
 * 去掉 string 两端的 /
 * @param str
 * @returns {*}
 */
let stripSlashes = str => str.replace(/(^\/+|\/+$)/g, "");

/**
 *
 * @param basepath
 * @returns {Function}
 */
let createRoute = basepath => element => {
  // 检查元素是否有 `path` `default` 属性，或是一个 `<Redirect />` 组件
  invariant(
    element.props.path || element.props.default || element.type === Redirect,
    `<Router>: Children of <Router> must have a \`path\` or \`default\` prop, or be a \`<Redirect>\`. None found on element type \`${
      element.type
    }\``
  );

  // 如果是 `<Redirect />` 组件则必须有 `from` 和 `to` 属性
  invariant(
    !(element.type === Redirect && (!element.props.from || !element.props.to)),
    `<Redirect from="${element.props.from} to="${
      element.props.to
    }"/> requires both "from" and "to" props when inside a <Router>.`
  );

  // 再检查 `<Redirect />` 组件的 `from` 和 `to` 是否合法
  invariant(
    !(
      element.type === Redirect &&
      !validateRedirect(element.props.from, element.props.to)
    ),
    `<Redirect from="${element.props.from} to="${
      element.props.to
    }"/> has mismatched dynamic segments, ensure both paths have the exact same dynamic segments.`
  );

  // 当匹配不上任何路由的时候返回设置了 default 的 Route
  // 所以不需要 path
  if (element.props.default) {
    return { value: element, default: true };
  }

  let elementPath =
    element.type === Redirect ? element.props.from : element.props.path;

  let path =
    elementPath === "/" // 实现相对路径
      ? basepath
      : `${stripSlashes(basepath)}/${stripSlashes(elementPath)}`;

  return {
    value: element,
    default: element.props.default,
    path: element.props.children ? `${stripSlashes(path)}/*` : path
  };
};

/**
 * 判断是否应该跳转
 * @param event
 * @returns {boolean}
 */
let shouldNavigate = event =>
  !event.defaultPrevented && // 判断 event 是否被 preventDefault() 的标识
  event.button === 0 && // 左击鼠标
  !(event.metaKey || event.altKey || event.ctrlKey || event.shiftKey); // 非 alt ctrl shift metaKey(windows command) 键

////////////////////////////////////////////////////////////////////////
export {
  Link,
  Location,
  LocationProvider,
  Match,
  Redirect,
  Router,
  ServerLocation,
  createHistory,
  createMemorySource,
  isRedirect,
  navigate,
  redirectTo
};
