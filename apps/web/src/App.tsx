// src/App.tsx
// Route table. Candidate pages sit inside CandidateRoute; /admin/* is lazy-loaded
// behind AdminRoute so the candidate bundle never includes admin code. Pages that
// later tasks build are placeholders for now.

import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { AdminRole } from '@exam/shared';
import { AdminRoute } from '@/components/layout/AdminRoute';
import { CandidateRoute } from '@/components/layout/CandidateRoute';
import CandidateLogin from '@/pages/candidate/Login';
import CandidateRegister from '@/pages/candidate/Register';
import CandidateLocation from '@/pages/candidate/Location';
import CandidateDashboard from '@/pages/candidate/Dashboard';
import CandidateExamDetail from '@/pages/candidate/ExamDetail';
import CandidateExam from '@/pages/candidate/Exam';
import CandidateSubmitted from '@/pages/candidate/Submitted';

const AdminLayout = lazy(() => import('@/components/layout/AdminLayout').then((m) => ({ default: m.AdminLayout })));
const Login = lazy(() => import('@/pages/admin/Login'));
const Dashboard = lazy(() => import('@/pages/admin/Dashboard'));
const AdminUsers = lazy(() => import('@/pages/admin/AdminUsers'));
const Integrations = lazy(() => import('@/pages/admin/Integrations'));
const AuditLog = lazy(() => import('@/pages/admin/AuditLog'));
const Roles = lazy(() => import('@/pages/admin/Roles'));
const Colleges = lazy(() => import('@/pages/admin/Colleges'));
const Questions = lazy(() => import('@/pages/admin/Questions'));
const Candidates = lazy(() => import('@/pages/admin/Candidates'));
const CandidateDetail = lazy(() => import('@/pages/admin/CandidateDetail'));
const Submissions = lazy(() => import('@/pages/admin/Submissions'));
const Marking = lazy(() => import('@/pages/admin/Marking'));
const Leaderboard = lazy(() => import('@/pages/admin/Leaderboard'));
const EmailTemplates = lazy(() => import('@/pages/admin/EmailTemplates'));

const SA = [AdminRole.SUPER_ADMIN] as const;
const Fallback = <div className="p-8 text-sm text-muted-foreground" role="status">Loading…</div>;

export function App() {
  return (
    <Suspense fallback={Fallback}>
      <Routes>
        <Route path="/login" element={<CandidateLogin />} />
        <Route path="/register" element={<CandidateRegister />} />
        <Route element={<CandidateRoute />}>
          <Route path="/location" element={<CandidateLocation />} />
          <Route path="/dashboard" element={<CandidateDashboard />} />
          <Route path="/exams/:applicationId" element={<CandidateExamDetail />} />
          <Route path="/exams/:applicationId/take" element={<CandidateExam />} />
          <Route path="/exams/:applicationId/submitted" element={<CandidateSubmitted />} />
          <Route path="/exam" element={<Navigate to="/dashboard" replace />} />
          <Route path="/submitted" element={<Navigate to="/dashboard" replace />} />
        </Route>

        <Route path="/admin/login" element={<Login />} />
        <Route element={<AdminRoute />}>
          <Route element={<AdminLayout />}>
            <Route path="/admin" element={<Dashboard />} />
            <Route path="/admin/submissions" element={<Submissions />} />
            <Route path="/admin/submissions/:attemptId" element={<Marking />} />
            <Route element={<AdminRoute roles={SA} />}>
              <Route path="/admin/candidates" element={<Candidates />} />
              <Route path="/admin/candidates/:id" element={<CandidateDetail />} />
              <Route path="/admin/questions" element={<Questions />} />
              <Route path="/admin/settings" element={<Roles />} />
              <Route path="/admin/colleges" element={<Colleges />} />
              <Route path="/admin/leaderboard" element={<Leaderboard />} />
              <Route path="/admin/email-templates" element={<EmailTemplates />} />
              <Route path="/admin/users" element={<AdminUsers />} />
              <Route path="/admin/integrations" element={<Integrations />} />
              <Route path="/admin/audit" element={<AuditLog />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </Suspense>
  );
}
