import type { Transition, Variants } from 'framer-motion';

// Spring transition presets
export const springs = {
  // Playful bounce - for modals, buttons
  bouncy: { type: 'spring', stiffness: 400, damping: 25 } as Transition,
  // Smooth and natural - for page transitions, cards
  gentle: { type: 'spring', stiffness: 300, damping: 30 } as Transition,
  // Quick and responsive - for micro-interactions
  snappy: { type: 'spring', stiffness: 500, damping: 30 } as Transition,
};

// Reusable animation variants
export const variants = {
  // Fade up - for content appearing
  fadeUp: {
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -8 },
  } as Variants,

  // Fade in - simple opacity
  fadeIn: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
  } as Variants,

  // Scale in - for modals and dialogs
  scaleIn: {
    initial: { opacity: 0, scale: 0.95 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.95 },
  } as Variants,

  // Slide in from right - for page transitions
  slideInRight: {
    initial: { opacity: 0, x: 20 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: -20 },
  } as Variants,

  // Slide in from left - for sidebar items
  slideInLeft: {
    initial: { opacity: 0, x: -12 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: -12 },
  } as Variants,
};

// Stagger container - parent that staggers children
export const staggerContainer: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.1,
    },
  },
};

// Stagger item - child that animates in sequence
export const staggerItem: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
};

// Card hover animation
export const cardHover = {
  rest: { scale: 1 },
  hover: { scale: 1.02 },
  tap: { scale: 0.98 },
};

// Button press animation
export const buttonPress = {
  rest: { scale: 1 },
  hover: { scale: 1.02 },
  tap: { scale: 0.95 },
};
