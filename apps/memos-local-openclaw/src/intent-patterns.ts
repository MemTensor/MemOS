export interface RegexPatternSource {
  pattern: string;
  flags?: string;
}

export interface CompiledRegexPattern {
  regex: RegExp;
}

/**
 * Skip memory recall patterns
 */
export const SKIP_RECALL_PATTERN_SOURCES: RegexPatternSource[] = [
  // continuation
  {
    pattern: "^(继续|接着|然后|下一步|continue|next|go\\s+on)$",
    flags: "i",
  },

  // acknowledgement
  {
    pattern: "^(好(的)?|行|嗯+|啊+|哦+|ok(ay)?|sure|got\\s+it|收到|明白了)$",
    flags: "i",
  },

  // session start events - should never trigger memory search
  { 
    pattern: "(new session|Session Startup|greet the user|read the required files)", 
    flags: "i", 
  },

  // slash commands - should never trigger memory search
  {
    pattern: "/(new|reset|status|reasoning|model|help|clear|undo|continue)(\\s|$)",
    flags: "i",
  },
  // real-time information queries
  {
    pattern:
      "(今|刚|最新|最近|新闻|消息|资讯|情况|发生|动态|网|浏览)",
  },

  // english realtime queries
  {
    pattern: "^(latest|today|recent).{0,12}(news|updates|events)",
    flags: "i",
  },
];

/**
 * Explicit memory recall patterns
 */
export const MEMORY_QUERY_PATTERN_SOURCES: RegexPatternSource[] = [
  // reference to past conversation
  {
    pattern: "(上次|之前|以前|刚才|刚刚).{0,10}(说|讲|问|聊|讨论|提到)",
  },

  // asking if assistant remembers
  {
    pattern: "(还记得|记得吗|do\\s+you\\s+remember)",
    flags: "i",
  },

  // explicit history search
  {
    pattern: "(聊天|对话|历史).{0,6}(记录|内容)?.{0,6}(查|找|看|搜索|查询)",
  },

  // english past reference
  {
    pattern: "(last\\s+time|previously|earlier|before\\s+we)",
    flags: "i",
  },

  // implicit reference (那个代码 / 刚才那个函数)
  {
    pattern:
      "(那个|刚才那个|刚刚那个).{0,8}(代码|函数|问题|回答|内容)",
  },
];

/**
 * compile regex patterns
 */
export function compilePatterns(
  sources: RegexPatternSource[]
): CompiledRegexPattern[] {
  return sources.map((s) => ({
    regex: new RegExp(s.pattern, s.flags ?? ""),
  }));
}

/**
 * test input against compiled patterns
 */
export function matchPatterns(
  input: string,
  patterns: CompiledRegexPattern[]
): boolean {
  return patterns.some((p) => p.regex.test(input));
}
