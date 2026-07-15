import Header from '../components/layout/Header';
import TaskHistory from '../components/history/TaskHistory';

export default function HistoryPage() {
  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-2xl font-semibold text-text mb-6">Task History</h1>
        <TaskHistory showTitle={false} />
      </main>
    </div>
  );
}
