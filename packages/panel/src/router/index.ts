import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "../stores/auth.js";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/login",
      name: "login",
      component: () => import("../views/Login.vue"),
    },
    {
      path: "/",
      name: "dashboard",
      component: () => import("../views/Dashboard.vue"),
      meta: { requiresAuth: true },
    },
    {
      path: "/logs",
      name: "logs",
      component: () => import("../views/Logs.vue"),
      meta: { requiresAuth: true },
    },
  ],
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    return { name: "login" };
  }
});

export { router };
