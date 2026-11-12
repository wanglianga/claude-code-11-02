import { createRouter, createWebHashHistory } from 'vue-router';

const routes = [
  { path: '/login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  { path: '/', component: () => import('./views/DashboardView.vue') },
  { path: '/tasks', component: () => import('./views/TasksView.vue') },
  { path: '/tasks/:id', component: () => import('./views/TaskDetailView.vue') },
  { path: '/interventions', component: () => import('./views/InterventionsView.vue') },
  { path: '/daily', component: () => import('./views/StoreDailyView.vue') },
  { path: '/issues', component: () => import('./views/IssuesView.vue') },
  { path: '/upload', component: () => import('./views/UploadView.vue') },
];

export const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach((to) => {
  if (!to.meta.public && !localStorage.getItem('ops_token')) return '/login';
});
