import invariant from "invariant";

// 工具库

////////////////////////////////////////////////////////////////////////////////
// startsWith(string, search) - Check if `string` starts with `search`
let startsWith = (string, search) => {
	return string.substr(0, search.length) === search;
};

////////////////////////////////////////////////////////////////////////////////
// pick(routes, uri)
//
// Ranks and picks the best route to match. Each segment gets the highest
// amount of points, then the type of segment gets an additional amount of
// points where
//
//     static > dynamic > splat > root
//
// This way we don't have to worry about the order of our routes, let the
// computers do it.
//
// A route looks like this
//
//     { path, default, value }
//
// And a returned match looks like:
//
//     { route, params, uri }
//
// I know, I should use TypeScript not comments for these types.
/**
 * 忽略组件的位置的先后顺序获取最匹配的 route
 * @param routes
 * @param uri
 * @returns {*|null}
 */
let pick = (routes, uri) => {
  let match;
  let default_;

  let [uriPathname] = uri.split("?");
  let uriSegments = segmentize(uriPathname);
  let isRootUri = uriSegments[0] === ""; // 是否为 根路由
  let ranked = rankRoutes(routes);

  for (let i = 0, l = ranked.length; i < l; i++) {
    let missed = false;
    let route = ranked[i].route;

    if (route.default) {
      default_ = {
        route,
        params: {},
        uri
      };
      continue;
    }

    let routeSegments = segmentize(route.path);
    let isRootRoute = routeSegments[0] === "";
    let params = {};
    let max = Math.max(uriSegments.length, routeSegments.length);
    let index = 0;

    for (; index < max; index++) {
      let routeSegment = routeSegments[index];
      let uriSegment = uriSegments[index];

      let isSplat = routeSegment === "*";
      if (isSplat) {
        // Hit a splat, just grab the rest, and return a match
        // uri:   /files/documents/work
        // route: /files/*

        // 处理贪婪路由 * 的值
        // 如 /files/* 对应 /files/documents/work 则 * 为 documents/work
        params["*"] = uriSegments
          .slice(index)
          .map(decodeURIComponent)
          .join("/");
        break;
      }

      if (uriSegment === undefined) {
        // URI is shorter than the route, no match
        // uri:   /users
        // route: /users/:userId

        // uri 比路由短，标记为不匹配
        missed = true;
        break;
      }

      let dynamicMatch = paramRe.exec(routeSegment); // 如 /^:(.+)/.exec(':id') 返回 [":id", "id", index: 0, input: ":id", groups: undefined]

      if (dynamicMatch && !isRootUri) {
        // 路由为 /:uri 或 /:path 被标记为不合法
        invariant(
          !reservedNames.includes(dynamicMatch[1]),
          `<Router> dynamic segment "${
            dynamicMatch[1]
          }" is a reserved name. Please use a different name in path "${
            route.path
          }".`
        );
        let value = decodeURIComponent(uriSegment);
        params[dynamicMatch[1]] = value;
      } else if (routeSegment !== uriSegment) {
        // Current segments don't match, not dynamic, not splat, so no match
        // uri:   /users/123/settings
        // route: /users/:id/profile
        missed = true;
        break;
      }
    }

    if (!missed) {
      match = {
        route,
        params,
        uri: "/" + uriSegments.slice(0, index).join("/") // 用 index 而不用 max 应该是对贪婪路由的处理
      };
      break;
    }
  }

  return match || default_ || null;
};

////////////////////////////////////////////////////////////////////////////////
// match(path, uri) - Matches just one path to a uri, also lol
let match = (path, uri) => pick([{ path }], uri);

////////////////////////////////////////////////////////////////////////////////
// resolve(to, basepath)
//
// Resolves URIs as though every path is a directory, no files.  Relative URIs
// in the browser can feel awkward because not only can you be "in a directory"
// you can be "at a file", too. For example
//
//     browserSpecResolve('foo', '/bar/') => /bar/foo
//     browserSpecResolve('foo', '/bar') => /foo
//
// But on the command line of a file system, it's not as complicated, you can't
// `cd` from a file, only directories.  This way, links have to know less about
// their current path. To go deeper you can do this:
//
//     <Link to="deeper"/>
//     // instead of
//     <Link to=`{${props.uri}/deeper}`/>
//
// Just like `cd`, if you want to go deeper from the command line, you do this:
//
//     cd deeper
//     # not
//     cd $(pwd)/deeper
//
// By treating every path as a directory, linking to relative paths should
// require less contextual information and (fingers crossed) be more intuitive.
let resolve = (to, base) => {
  // /foo/bar, /baz/qux => /foo/bar
  if (startsWith(to, "/")) {
    return to;
  }

  let [toPathname, toQuery] = to.split("?");
  let [basePathname] = base.split("?");

  let toSegments = segmentize(toPathname);
  let baseSegments = segmentize(basePathname);

  // ?a=b, /users?b=c => /users?a=b
  if (toSegments[0] === "") {
    return addQuery(basePathname, toQuery);
  }

  // profile, /users/789 => /users/789/profile
  if (!startsWith(toSegments[0], ".")) {
    let pathname = baseSegments.concat(toSegments).join("/");
    return addQuery((basePathname === "/" ? "" : "/") + pathname, toQuery);
  }

  // ./         /users/123  =>  /users/123
  // ../        /users/123  =>  /users
  // ../..      /users/123  =>  /
  // ../../one  /a/b/c/d    =>  /a/b/one
  // .././one   /a/b/c/d    =>  /a/b/c/one
  let allSegments = baseSegments.concat(toSegments);
  let segments = [];
  for (let i = 0, l = allSegments.length; i < l; i++) {
    let segment = allSegments[i];
    if (segment === "..") segments.pop();
    else if (segment !== ".") segments.push(segment);
  }

  return addQuery("/" + segments.join("/"), toQuery);
};

////////////////////////////////////////////////////////////////////////////////
// insertParams(path, params)
let insertParams = (path, params) => {
  let segments = segmentize(path);
  return (
    "/" +
    segments
      .map(segment => {
        let match = paramRe.exec(segment);
        return match ? params[match[1]] : segment;
      })
      .join("/")
  );
};

/**
 * 检查 Redirect 组件 的 from 和 to 是否合法
 * @param from
 * @param to
 * @returns {boolean}
 */
let validateRedirect = (from, to) => {
  let filter = segment => isDynamic(segment);
  let fromString = segmentize(from)
    .filter(filter)
    .sort()
    .join("/");
  let toString = segmentize(to)
    .filter(filter)
    .sort()
    .join("/");
  return fromString === toString;
};

////////////////////////////////////////////////////////////////////////////////
// Junk
let paramRe = /^:(.+)/;

let SEGMENT_POINTS = 4;
let STATIC_POINTS = 3;
let DYNAMIC_POINTS = 2;
let SPLAT_PENALTY = 1;
let ROOT_POINTS = 1;

let isRootSegment = segment => segment == ""; // 根路由 也就是 /
let isDynamic = segment => paramRe.test(segment); // 动态路由 例如 /user/:id
let isSplat = segment => segment === "*"; // 贪婪路由 例如 /user/*

/**
 * 给单个 route 打分 static > dynamic > splat > root
 * @param route
 * @param index
 * @returns {{route: *, score: number, index: *}}
 */
let rankRoute = (route, index) => {
  let score = route.default // default 打分最低
    ? 0
    : segmentize(route.path).reduce((score, segment) => {
        score += SEGMENT_POINTS;
        if (isRootSegment(segment)) score += ROOT_POINTS;
        else if (isDynamic(segment)) score += DYNAMIC_POINTS;
        else if (isSplat(segment)) score -= SEGMENT_POINTS + SPLAT_PENALTY;
        else score += STATIC_POINTS; // 一般的路由 例如 /user
        return score;
      }, 0);
  return { route, score, index };
};

/**
 * 根据打分给 routes 排序
 * @param routes
 * @returns []
 */
let rankRoutes = routes =>
  routes
    .map(rankRoute)
    .sort(
      (a, b) =>
        a.score < b.score ? 1 : a.score > b.score ? -1 : a.index - b.index
    );

/**
 * 根据 / 切割 uri
 * @param uri
 * @returns {*|string[]}
 */
let segmentize = uri =>
  uri
    // strip starting/ending slashes
    .replace(/(^\/+|\/+$)/g, "")
    .split("/");

let addQuery = (pathname, query) => pathname + (query ? `?${query}` : "");

let reservedNames = ["uri", "path"];

////////////////////////////////////////////////////////////////////////////////
export { startsWith, pick, match, resolve, insertParams, validateRedirect };
