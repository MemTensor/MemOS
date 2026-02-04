import { describe, it, expect } from 'vitest';
import { isWaitingForUser } from '../../../../src/renderer/lib/waiting-detection';

describe('isWaitingForUser', () => {
  describe('should return true for messages indicating waiting', () => {
    // "Let me know" patterns
    it.each([
      'Let me know when you are done',
      'let me know once you have logged in',
      'Let me know after you complete the form',
      'let me know if you need help',
    ])('detects "let me know" pattern: "%s"', (message) => {
      expect(isWaitingForUser(message)).toBe(true);
    });

    // "Tell me" patterns
    it.each([
      'Tell me when you are ready',
      'tell me once you finish',
      'Tell me after you have entered your credentials',
    ])('detects "tell me" pattern: "%s"', (message) => {
      expect(isWaitingForUser(message)).toBe(true);
    });

    // "Waiting for you" patterns
    it.each([
      'I am waiting for you to complete this',
      'I will wait for your response',
      "I'll wait until you are done",
      'Waiting on you to finish',
    ])('detects "waiting for you" pattern: "%s"', (message) => {
      expect(isWaitingForUser(message)).toBe(true);
    });

    // "Once you" / "After you" / "When you" patterns
    it.each([
      "Once you've logged in, I can continue",
      'Once you have completed the form',
      'After you enter your password',
      "After you've finished, click continue",
      'When you are done, let me know',
      "When you've entered the code",
      'When you want to proceed',
    ])('detects conditional patterns: "%s"', (message) => {
      expect(isWaitingForUser(message)).toBe(true);
    });

    // "Please [action]" patterns
    it.each([
      'Please log in to continue',
      'Please login with your credentials',
      'Please sign in to your account',
      'Please enter your password',
      'Please fill out the form',
      'Please complete the verification',
      'Please click the submit button',
      'Please select an option',
      'Please confirm your identity',
      'Please verify your email',
      'Please authenticate using 2FA',
    ])('detects "please" action patterns: "%s"', (message) => {
      expect(isWaitingForUser(message)).toBe(true);
    });

    // Login/authentication specific
    it.each([
      'You need to log in manually',
      'Please sign in yourself',
      'Enter your credentials to proceed',
      'Enter your password in the field',
      'Enter your OTP code',
      'Authenticate yourself to continue',
      'Complete the login process',
      'Complete the authentication',
      'Complete the captcha verification',
      'Verify your identity',
      'Verify your account',
    ])('detects authentication patterns: "%s"', (message) => {
      expect(isWaitingForUser(message)).toBe(true);
    });

    // Manual action required
    it.each([
      'This requires manual action',
      'A manual step is needed',
      'You need to manually complete this',
      'Manually enter your details',
      'I need you to click the button',
      'This requires you to fill the form',
      "You'll need to do this yourself",
      'You will need to verify',
    ])('detects manual action patterns: "%s"', (message) => {
      expect(isWaitingForUser(message)).toBe(true);
    });

    // Ready/done prompts
    it.each([
      "When you're done, I can proceed",
      'When you are ready, continue',
      'Once done, click the button',
      'Once ready, let me know',
      'After done, we can move on',
      "After you're finished",
    ])('detects ready/done prompts: "%s"', (message) => {
      expect(isWaitingForUser(message)).toBe(true);
    });

    // Continuation prompts
    it.each([
      'Ready to continue?',
      'Ready to proceed with the next step?',
      'Continue when you are done',
      'Proceed when ready',
      'Click continue when finished',
      'Press continue after you log in',
      'Hit continue once complete',
    ])('detects continuation prompts: "%s"', (message) => {
      expect(isWaitingForUser(message)).toBe(true);
    });

    // Explicit waiting statements
    it.each([
      "I'll be here when you need me",
      'I will be here waiting',
      'Standing by for your input',
      'Awaiting your response',
      'Waiting for your input',
      'Waiting for the user to act',
      'Waiting for manual intervention',
    ])('detects explicit waiting: "%s"', (message) => {
      expect(isWaitingForUser(message)).toBe(true);
    });
  });

  describe('should return false for completed task messages', () => {
    it.each([
      'I have navigated to ynet.co.il',
      'Done! The page has loaded.',
      'Finished navigating to the website.',
      'Successfully opened the page.',
      'The task is complete.',
      'I clicked the button as requested.',
      'The form has been submitted.',
      'Here is the information you requested.',
      'I found the following results:',
      'The file has been saved.',
      'Screenshot captured successfully.',
      '',
      'All done!',
      'Task completed successfully.',
      'Navigation complete.',
    ])('returns false for: "%s"', (message) => {
      expect(isWaitingForUser(message)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false for empty string', () => {
      expect(isWaitingForUser('')).toBe(false);
    });

    it('returns false for null-ish content', () => {
      expect(isWaitingForUser(null as unknown as string)).toBe(false);
      expect(isWaitingForUser(undefined as unknown as string)).toBe(false);
    });

    it('is case insensitive', () => {
      expect(isWaitingForUser('LET ME KNOW WHEN YOU ARE DONE')).toBe(true);
      expect(isWaitingForUser('Please Log In')).toBe(true);
      expect(isWaitingForUser('WAITING FOR YOU')).toBe(true);
    });

    it('handles multi-line messages', () => {
      const multiLineWaiting = `I've opened the login page.

Please enter your credentials and let me know when you're done.`;
      expect(isWaitingForUser(multiLineWaiting)).toBe(true);

      const multiLineComplete = `I've navigated to the page.

The content has loaded successfully.`;
      expect(isWaitingForUser(multiLineComplete)).toBe(false);
    });
  });
});
