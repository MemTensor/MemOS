/**
 * Detect if the assistant message indicates it's waiting for user action.
 * Only show "Done, Continue" button when the agent explicitly signals
 * it needs the user to do something manually before continuing.
 */
export function isWaitingForUser(content: string): boolean {
  if (!content) return false;

  const waitingPatterns = [
    // Direct "let me know" / "tell me" patterns
    /let me know when/i,
    /let me know once/i,
    /let me know after/i,
    /let me know if you/i,
    /tell me when/i,
    /tell me once/i,
    /tell me after/i,
    /notify me when/i,
    /inform me when/i,

    // "Waiting for you" patterns
    /waiting for you/i,
    /wait for you/i,
    /waiting on you/i,
    /i('ll| will) wait/i,

    // "Once you" / "After you" / "When you" patterns
    /once you('ve| have| are| finish| complete| do| did| enter| log|'re)/i,
    /after you('ve| have| are| finish| complete| do| did| enter| log|'re)/i,
    /when you('ve| have| are| finish| complete| do| did| enter| log|'re| want)/i,

    // "Please [action] and" patterns (user needs to do something)
    /please (log in|login|sign in|signin|enter|fill|complete|finish|click|tap|select|choose|confirm|verify|authenticate)/i,

    // Login/authentication specific
    /log in (manually|yourself)/i,
    /sign in (manually|yourself)/i,
    /enter your (credentials|password|username|email|code|otp|pin)/i,
    /authenticate (yourself|manually)/i,
    /complete (the )?(login|signin|sign-in|authentication|verification|captcha|2fa|mfa)/i,
    /verify your (identity|account|email|phone)/i,

    // Manual action required
    /manual (action|step|intervention|input)/i,
    /manually (complete|enter|fill|do|perform|click|select)/i,
    /need(s)? you to/i,
    /require(s)? you to/i,
    /you('ll| will) need to/i,

    // Ready/done prompts
    /when you('re| are) (done|ready|finished|complete)/i,
    /once (done|ready|finished|complete)/i,
    /after (you('re| are|'ve| have) )?(done|ready|finished|complete)/i,

    // Continuation prompts
    /ready to (continue|proceed|go on)/i,
    /(continue|proceed) when/i,
    /click "?continue"? when/i,
    /press "?continue"? (when|after|once)/i,
    /hit "?continue"? (when|after|once)/i,

    // Explicit waiting statements
    /i('ll| will) be here/i,
    /standing by/i,
    /awaiting your/i,
    /waiting for (your|the user|manual|human)/i,
  ];

  return waitingPatterns.some(pattern => pattern.test(content));
}
