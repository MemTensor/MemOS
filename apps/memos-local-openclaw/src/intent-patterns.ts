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
    pattern: "^(继续|接着|然后|下一步|continue|next|go on)$",
    flags: "i",
  },

  // acknowledgement
  {
    pattern: "^(好(的)?|行|嗯+|啊+|哦+|ok(ay)?|sure|got it|收到|明白了)$",
    flags: "i",
  },

  // real-time information queries
  {
    pattern:
      "^(今天|今日|刚刚|刚才|最新|最近).{0,12}(新闻|消息|资讯|情况|发生|动态)",
  },

  // english realtime queries
  {
    pattern:
      "^(latest|today|recent).{0,12}(news|updates|events)",
    flags: "i",
  },
];

/**
 * Explicit memory recall patterns
 */
export const MEMORY_QUERY_PATTERN_SOURCES: RegexPatternSource[] = [
  // reference to past conversation
  {
    pattern:
      "(上次|之前|以前|刚才|刚刚).{0,10}(说|讲|问|聊|讨论|提到|写|给我|那个)",
  },

  // asking if assistant remembers
  {
    pattern:
      "(还记得|记不记得|记得吗|remember|do you remember)",
    flags: "i",
  },

  // explicit history search
  {
    pattern:
      "(聊天|对话|历史).{0,6}(记录|内容)?.{0,6}(查|找|看|搜索|查询)",
  },

  // english past reference
  {
    pattern:
      "(last time|previously|earlier|before we)",
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
