import { createRouter, createWebHashHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: () => import('../views/LoginPage.vue'), meta: { public: true } },
    { path: '/register', component: () => import('../views/RegisterPage.vue'), meta: { public: true } },
    {
      path: '/',
      component: () => import('../views/MainLayout.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/datasource',
      component: () => import('../views/MainLayout.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/:convId',
      component: () => import('../views/MainLayout.vue'),
      meta: { requiresAuth: true },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to, _from, next) => {
  const authStore = useAuthStore();
  if (to.meta.public) {
    if (authStore.isLoggedIn) {
      next('/');
    } else {
      next();
    }
    return;
  }
  if (to.meta.requiresAuth) {
    if (!authStore.token) {
      next('/login');
      return;
    }
    if (!authStore.user) {
      await authStore.fetchUser();
    }
    next();
    return;
  }
  next();
});

export default router;
