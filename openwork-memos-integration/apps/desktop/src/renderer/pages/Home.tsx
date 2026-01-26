'use client';

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import TaskInputBar from '../components/landing/TaskInputBar';
import SettingsDialog from '../components/layout/SettingsDialog';
import { useTaskStore } from '../stores/taskStore';
import { getAccomplish } from '../lib/accomplish';
import { springs, staggerContainer, staggerItem } from '../lib/animations';
import { Card, CardContent } from '@/components/ui/card';
import { ChevronDown } from 'lucide-react';
import { hasAnyReadyProvider } from '@accomplish/shared';

// Import use case images for proper bundling in production
import calendarPrepNotesImg from '/assets/usecases/calendar-prep-notes.png';
import inboxPromoCleanupImg from '/assets/usecases/inbox-promo-cleanup.png';
import competitorPricingDeckImg from '/assets/usecases/competitor-pricing-deck.png';
import notionApiAuditImg from '/assets/usecases/notion-api-audit.png';
import stagingVsProdVisualImg from '/assets/usecases/staging-vs-prod-visual.png';
import prodBrokenLinksImg from '/assets/usecases/prod-broken-links.png';
import stockPortfolioAlertsImg from '/assets/usecases/stock-portfolio-alerts.png';
import jobApplicationAutomationImg from '/assets/usecases/job-application-automation.png';
import eventCalendarBuilderImg from '/assets/usecases/event-calendar-builder.png';

const USE_CASE_EXAMPLES = [
  {
    title: 'Calendar Prep Notes',
    description: 'Review tomorrow\'s meetings and draft a prep notes doc.',
    prompt: 'Check my Google Calendar for tomorrow\'s meetings and draft preparation notes in a new Google Doc.',
    image: calendarPrepNotesImg,
  },
  {
    title: 'Inbox Promo Cleanup',
    description: 'Clear promotional emails from the last 24 hours.',
    prompt: 'Go to my Gmail inbox and delete all promotional emails from the last 24 hours.',
    image: inboxPromoCleanupImg,
  },
  {
    title: 'Competitor Pricing Deck',
    description: 'Analyze competitor pricing and draft a slide with recommendations.',
    prompt: 'Pull pricing and features from these 5 competitor sites [list URLs], save to a CSV, analyze our pricing gaps, and draft a recommendation slide in Google Slides for Monday\'s meeting.',
    image: competitorPricingDeckImg,
  },
  {
    title: 'Notion API Audit',
    description: 'Scan a Notion wiki for old API mentions with direct links.',
    prompt: 'Read through this Notion wiki at [URL] and find all mentions of the old API, listing them with page links.',
    image: notionApiAuditImg,
  },
  {
    title: 'Staging vs Prod Visual Check',
    description: 'Compare staging and production visuals with screenshots.',
    prompt: 'Compare my staging site at [URL] to production at [URL] and screenshot any visual differences.',
    image: stagingVsProdVisualImg,
  },
  {
    title: 'Production Broken Links',
    description: 'Check my website for broken links.',
    prompt: 'Open [URL], click through every link, and report any 404 errors.',
    image: prodBrokenLinksImg,
  },
  {
    title: 'Portfolio Monitoring',
    description: 'Watch stock prices, and alert on drops and spikes.',
    prompt: 'Monitor my stock portfolio on [broker site], alert on price drops and spikes.',
    image: stockPortfolioAlertsImg,
  },
  {
    title: 'Job Application Automation',
    description: 'Filter jobs and submit applications with saved profiles.',
    prompt: 'Find job listings from Indeed for [query], sort by salary, and apply to the top 5 using my profile.',
    image: jobApplicationAutomationImg,
  },
  {
    title: 'Event Calendar Builder',
    description: 'Select top events and add them to the calendar.',
    prompt: 'Scrape event listings from Eventbrite, filter by location, and add top 5 to my calendar.',
    image: eventCalendarBuilderImg,
  },
];

export default function HomePage() {
  const [prompt, setPrompt] = useState('');
  const [showExamples, setShowExamples] = useState(true);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const { startTask, isLoading, addTaskUpdate, setPermissionRequest } = useTaskStore();
  const navigate = useNavigate();
  const accomplish = getAccomplish();

  // Subscribe to task events
  useEffect(() => {
    const unsubscribeTask = accomplish.onTaskUpdate((event) => {
      addTaskUpdate(event);
    });

    const unsubscribePermission = accomplish.onPermissionRequest((request) => {
      setPermissionRequest(request);
    });

    return () => {
      unsubscribeTask();
      unsubscribePermission();
    };
  }, [addTaskUpdate, setPermissionRequest, accomplish]);

  const executeTask = useCallback(async () => {
    if (!prompt.trim() || isLoading) return;

    const taskId = `task_${Date.now()}`;
    const task = await startTask({ prompt: prompt.trim(), taskId });
    if (task) {
      navigate(`/execution/${task.id}`);
    }
  }, [prompt, isLoading, startTask, navigate]);

  const handleSubmit = async () => {
    if (!prompt.trim() || isLoading) return;

    // Check if any provider is ready before sending (skip in E2E mode)
    const isE2EMode = await accomplish.isE2EMode();
    if (!isE2EMode) {
      const settings = await accomplish.getProviderSettings();
      if (!hasAnyReadyProvider(settings)) {
        setShowSettingsDialog(true);
        return;
      }
    }

    await executeTask();
  };

  const handleSettingsDialogChange = (open: boolean) => {
    setShowSettingsDialog(open);
  };

  const handleApiKeySaved = async () => {
    // API key was saved - close dialog and execute the task
    setShowSettingsDialog(false);
    if (prompt.trim()) {
      await executeTask();
    }
  };

  const handleExampleClick = (examplePrompt: string) => {
    setPrompt(examplePrompt);
  };

  return (
    <>
      <SettingsDialog
        open={showSettingsDialog}
        onOpenChange={handleSettingsDialogChange}
        onApiKeySaved={handleApiKeySaved}
      />
      <div
        className="h-full flex items-center justify-center p-6 overflow-y-auto bg-accent"
      >
      <div className="w-full max-w-2xl flex flex-col items-center gap-8">
        {/* Main Title */}
        <motion.h1
          data-testid="home-title"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={springs.gentle}
          className="text-4xl font-light tracking-tight text-foreground"
        >
          What will you accomplish today?
        </motion.h1>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...springs.gentle, delay: 0.1 }}
          className="w-full"
        >
          <Card className="w-full bg-card/95 backdrop-blur-md shadow-xl gap-0 py-0 flex flex-col max-h-[calc(100vh-3rem)]">
            <CardContent className="p-6 pb-4 flex-shrink-0">
              {/* Input Section */}
              <TaskInputBar
                value={prompt}
                onChange={setPrompt}
                onSubmit={handleSubmit}
                isLoading={isLoading}
                placeholder="Describe a task and let AI handle the rest"
                large={true}
                autoFocus={true}
              />
            </CardContent>

            {/* Examples Toggle */}
            <div className="border-t border-border">
              <button
                onClick={() => setShowExamples(!showExamples)}
                className="w-full px-6 py-3 flex items-center justify-between text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors duration-200"
              >
                <span>Example prompts</span>
                <motion.div
                  animate={{ rotate: showExamples ? 180 : 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <ChevronDown className="h-4 w-4" />
                </motion.div>
              </button>

              <AnimatePresence>
                {showExamples && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div
                      className="px-6 pt-1 pb-4 overflow-y-auto max-h-[360px]"
                      style={{
                        background: 'linear-gradient(to bottom, hsl(var(--muted)) 0%, hsl(var(--background)) 100%)',
                        backgroundAttachment: 'fixed',
                      }}
                    >
                      <motion.div
                        variants={staggerContainer}
                        initial="initial"
                        animate="animate"
                        className="grid grid-cols-3 gap-3"
                      >
                        {USE_CASE_EXAMPLES.map((example, index) => (
                          <motion.button
                            key={index}
                            data-testid={`home-example-${index}`}
                            variants={staggerItem}
                            transition={springs.gentle}
                            whileHover={{ scale: 1.03, transition: { duration: 0.15 } }}
                            whileTap={{ scale: 0.97 }}
                            onClick={() => handleExampleClick(example.prompt)}
                            className="flex flex-col items-center gap-2 p-3 rounded-lg border border-border bg-card hover:border-ring hover:bg-muted/50"
                          >
                            <img
                              src={example.image}
                              alt={example.title}
                              className="w-12 h-12 object-cover rounded"
                            />
                            <div className="flex flex-col items-center gap-1 w-full">
                              <div className="font-medium text-xs text-foreground text-center">
                                {example.title}
                              </div>
                              <div className="text-xs text-muted-foreground text-center line-clamp-2">
                                {example.description}
                              </div>
                            </div>
                          </motion.button>
                        ))}
                      </motion.div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </Card>
        </motion.div>
      </div>
    </div>
    </>
  );
}
