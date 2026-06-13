import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "../stores/auth";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/chat" },
    {
      path: "/login",
      component: () => import("../views/LoginPage.vue"),
      meta: { public: true },
    },
    {
      path: "/register",
      component: () => import("../views/RegisterPage.vue"),
      meta: { public: true },
    },
    {
      path: "/forgot-password",
      component: () => import("../views/ForgotPasswordPage.vue"),
      meta: { public: true },
    },
    {
      path: "/reset-password",
      component: () => import("../views/ResetPasswordPage.vue"),
      meta: { public: true },
    },
    {
      path: "/chat",
      component: () => import("../views/MainLayout.vue"),
      meta: { requiresAuth: true },
      children: [
        {
          path: "",
          name: "chat",
          component: () => import("../views/ChatView.vue"),
        },
        {
          path: ":convId",
          name: "chat-detail",
          component: () => import("../views/ChatView.vue"),
        },
      ],
    },
    {
      path: "/datasource",
      component: () => import("../views/MainLayout.vue"),
      meta: { requiresAuth: true },
      children: [
        {
          path: "",
          name: "datasource",
          component: () => import("../views/DataSourceView.vue"),
        },
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach(async (to, _from, next) => {
  const authStore = useAuthStore();
  if (to.meta.public) {
    if (authStore.isLoggedIn) {
      next("/chat");
    } else {
      next();
    }
    return;
  }
  if (to.meta.requiresAuth) {
    if (!authStore.token) {
      next("/login");
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
