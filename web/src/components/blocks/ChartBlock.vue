<template>
  <div class="chart-block">
    <div v-if="!chartData" class="chart-skeleton">
      <div class="skeleton-title"></div>
      <div class="skeleton-body">
        <div class="skeleton-bar" v-for="n in 5" :key="n" :style="{ height: barHeights[n - 1] }"></div>
      </div>
      <div class="skeleton-axis"></div>
    </div>
    <div v-else ref="chartRef" class="chart-container"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import {
  TitleComponent,
  TooltipComponent,
  GridComponent,
  LegendComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ChartData } from '../../types';

echarts.use([
  BarChart, LineChart, PieChart, ScatterChart,
  TitleComponent, TooltipComponent, GridComponent, LegendComponent,
  CanvasRenderer,
]);

const COLORS = ['#6366f1', '#22d3ee', '#f59e0b', '#ef4444', '#10b981', '#8b5cf6', '#ec4899'];

const props = defineProps<{
  chartData?: ChartData;
}>();

const chartRef = ref<HTMLElement>();
const barHeights = ['60%', '85%', '45%', '70%', '55%'];
let chart: echarts.ECharts | null = null;

function buildOption(data: ChartData): Record<string, unknown> {
  const isPie = data.chartType === 'pie';

  const base: Record<string, unknown> = {
    title: {
      text: data.title,
      left: 'center',
      textStyle: { color: '#e2e8f0', fontSize: 15, fontWeight: 600 },
    },
    tooltip: {
      trigger: isPie ? 'item' : 'axis',
      backgroundColor: 'rgba(15, 23, 42, 0.9)',
      borderColor: 'rgba(99, 102, 241, 0.3)',
      textStyle: { color: '#e2e8f0', fontSize: 12 },
    },
    color: COLORS,
  };

  if (isPie) {
    const pieData = data.series[0]?.data.map((val, i) => ({
      name: data.xAxis?.[i] ?? data.series[0]?.name ?? `${i}`,
      value: val,
    })) ?? [];

    base.series = [{
      type: 'pie',
      radius: ['40%', '70%'],
      center: ['50%', '55%'],
      itemStyle: { borderRadius: 6, borderColor: '#0f172a', borderWidth: 2 },
      label: { color: '#94a3b8', fontSize: 12 },
      emphasis: {
        label: { fontSize: 14, fontWeight: 'bold' },
        itemStyle: { shadowBlur: 10, shadowColor: 'rgba(99, 102, 241, 0.5)' },
      },
      data: pieData,
    }];
    return base;
  }

  base.grid = {
    left: '3%', right: '4%', bottom: '3%', containLabel: true,
  };
  base.xAxis = {
    type: 'category',
    data: data.xAxis ?? [],
    axisLabel: { color: '#94a3b8', fontSize: 11 },
    axisLine: { lineStyle: { color: '#334155' } },
    splitLine: { show: false },
  };
  base.yAxis = {
    type: 'value',
    axisLabel: { color: '#94a3b8', fontSize: 11 },
    splitLine: { lineStyle: { color: '#1e293b', type: 'dashed' } },
  };

  if (data.series.length > 1) {
    base.legend = {
      top: 30,
      textStyle: { color: '#94a3b8', fontSize: 12 },
    };
  }

  base.series = data.series.map((s, i) => {
    const seriesBase: Record<string, unknown> = {
      name: s.name,
      type: data.chartType,
      data: s.data,
    };

    if (data.chartType === 'line') {
      seriesBase.smooth = true;
      seriesBase.symbol = 'circle';
      seriesBase.symbolSize = 6;
      seriesBase.lineStyle = { width: 2.5 };
      seriesBase.areaStyle = {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: COLORS[i % COLORS.length] + '40' },
          { offset: 1, color: COLORS[i % COLORS.length] + '05' },
        ]),
      };
    }

    if (data.chartType === 'bar') {
      seriesBase.barMaxWidth = 40;
      seriesBase.itemStyle = { borderRadius: [4, 4, 0, 0] };
    }

    return seriesBase;
  });

  return base;
}

function renderChart() {
  if (!chartRef.value || !props.chartData) return;
  if (!chart) {
    chart = echarts.init(chartRef.value, undefined, { renderer: 'canvas' });
  }
  chart.setOption(buildOption(props.chartData), true);
}

function handleResize() {
  chart?.resize();
}

onMounted(() => {
  renderChart();
  window.addEventListener('resize', handleResize);
});

watch(() => props.chartData, () => {
  nextTick(renderChart);
}, { deep: true });

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  chart?.dispose();
  chart = null;
});
</script>

<style scoped>
.chart-block {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: linear-gradient(135deg, rgba(15, 23, 42, 0.6), rgba(30, 41, 59, 0.4));
  backdrop-filter: blur(8px);
}

.chart-container {
  width: 100%;
  height: 380px;
}

.chart-skeleton {
  width: 100%;
  height: 380px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px 40px 20px;
  box-sizing: border-box;
}

.skeleton-title {
  width: 140px;
  height: 14px;
  border-radius: 4px;
  background: rgba(99, 102, 241, 0.12);
  animation: shimmer 1.8s infinite ease-in-out;
  margin-bottom: 24px;
}

.skeleton-body {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 24px;
  padding-bottom: 8px;
}

.skeleton-bar {
  width: 36px;
  border-radius: 4px 4px 0 0;
  background: rgba(99, 102, 241, 0.10);
  animation: shimmer 1.8s infinite ease-in-out;
}

.skeleton-bar:nth-child(2) { animation-delay: 0.15s; }
.skeleton-bar:nth-child(3) { animation-delay: 0.3s; }
.skeleton-bar:nth-child(4) { animation-delay: 0.45s; }
.skeleton-bar:nth-child(5) { animation-delay: 0.6s; }

.skeleton-axis {
  width: 100%;
  height: 1px;
  background: rgba(99, 102, 241, 0.12);
}

@keyframes shimmer {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}
</style>
