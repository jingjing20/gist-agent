import { defineStore } from "pinia";
import { ref } from "vue";

export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: number;
  type: ToastType;
  message: string;
  duration?: number;
}

export const useToastStore = defineStore("toast", () => {
  const toasts = ref<Toast[]>([]);
  let nextId = 1;

  function add(message: string, type: ToastType = "info", duration = 3000) {
    const id = nextId++;
    toasts.value.push({ id, type, message, duration });

    if (duration > 0) {
      setTimeout(() => {
        remove(id);
      }, duration);
    }
  }

  function success(message: string, duration?: number) {
    add(message, "success", duration);
  }

  function error(message: string, duration?: number) {
    add(message, "error", duration);
  }

  function warn(message: string, duration?: number) {
    add(message, "warning", duration);
  }

  function info(message: string, duration?: number) {
    add(message, "info", duration);
  }

  function remove(id: number) {
    const index = toasts.value.findIndex((t) => t.id === id);
    if (index !== -1) {
      toasts.value.splice(index, 1);
    }
  }

  return {
    toasts,
    success,
    error,
    warn,
    info,
    remove,
  };
});
