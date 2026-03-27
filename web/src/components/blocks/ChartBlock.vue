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

// Updated to match Gist Agent New Theme (Sky/Blue/Violet)
const COLORS = [
  '#0ea5e9', // da-primary (Sky-500)
  '#8b5cf6', // da-gradient-start (Violet-500)
  '#3b82f6', // da-gradient-end (Blue-500)
  '#10b981', // Emerald-500
  '#f59e0b', // Amber-500
  '#ec4899', // Pink-500
  '#ef4444', // Red-500
];

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
      top: 10,
      textStyle: { 
        color: '#e2e8f0', // da-text-main
        fontSize: 15, 
        fontWeight: 600 
      },
    },
    tooltip: {
      trigger: isPie ? 'item' : 'axis',
      backgroundColor: 'rgba(26, 31, 46, 0.95)', // da-chart-bg / panel based
      borderColor: 'rgba(14, 165, 233, 0.4)', // da-primary-alpha
      borderWidth: 1,
      textStyle: { color: '#e2e8f0', fontSize: 12 },
      padding: [10, 14],
      borderRadius: 8,
      shadowBlur: 10,
      shadowColor: 'rgba(0, 0, 0, 0.3)',
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
      radius: ['45%', '70%'],
      center: ['50%', '55%'],
      itemStyle: { 
        borderRadius: 8, 
        borderColor: '#1a1f2e', // da-chart-bg
        borderWidth: 2 
      },
      label: { color: '#94a3b8', fontSize: 12 },
      emphasis: {
        label: { fontSize: 14, fontWeight: 'bold' },
        itemStyle: { 
          shadowBlur: 15, 
          shadowColor: 'rgba(14, 165, 233, 0.4)' // da-primary shadow
        },
      },
      data: pieData,
    }];
    return base;
  }

  base.grid = {
    left: 15, 
    right: 15, 
    bottom: 10, 
    top: data.series.length > 1 ? 85 : 55,
    containLabel: true,
  };
  
  base.xAxis = {
    type: 'category',
    data: data.xAxis ?? [],
    axisLabel: { color: '#94a3b8', fontSize: 11, margin: 12 },
    axisLine: { lineStyle: { color: '#333a4d' } }, // da-border
    axisTick: { show: false },
    splitLine: { show: false },
  };
  
  base.yAxis = {
    type: 'value',
    axisLabel: { color: '#94a3b8', fontSize: 11 },
    splitLine: { 
      lineStyle: { 
        color: 'rgba(51, 58, 77, 0.4)', // da-border light alpha
        type: 'dashed' 
      } 
    },
  };

  if (data.series.length > 1) {
    base.legend = {
      top: 40,
      itemGap: 15,
      itemWidth: 10,
      itemHeight: 10,
      icon: 'circle',
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
      seriesBase.symbolSize = 8;
      seriesBase.lineStyle = { width: 3 };
      seriesBase.areaStyle = {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: COLORS[i % COLORS.length] + '33' },
          { offset: 1, color: COLORS[i % COLORS.length] + '00' },
        ]),
      };
    }

    if (data.chartType === 'bar') {
      seriesBase.barMaxWidth = 32;
      seriesBase.itemStyle = { 
        borderRadius: [6, 6, 0, 0],
        // Gradient for bars
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: COLORS[i % COLORS.length] },
          { offset: 1, color: COLORS[i % COLORS.length] + 'aa' },
        ])
      };
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
  border: 1px solid var(--da-border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--da-chart-bg);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.chart-container {
  width: 100%;
  height: 380px;
  padding: 4px;
  box-sizing: border-box;
}

.chart-skeleton {
  width: 100%;
  height: 380px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 32px 40px 24px;
  box-sizing: border-box;
}

.skeleton-title {
  width: 160px;
  height: 16px;
  border-radius: 4px;
  background: rgba(14, 165, 233, 0.12); /* da-primary alpha */
  animation: shimmer 1.8s infinite ease-in-out;
  margin-bottom: 32px;
}

.skeleton-body {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 24px;
  padding-bottom: 12px;
}

.skeleton-bar {
  width: 36px;
  border-radius: 6px 6px 0 0;
  background: rgba(14, 165, 233, 0.08); /* da-primary alpha */
  animation: shimmer 1.8s infinite ease-in-out;
}

.skeleton-bar:nth-child(2) { animation-delay: 0.15s; background: rgba(139, 92, 246, 0.08); }
.skeleton-bar:nth-child(3) { animation-delay: 0.3s; background: rgba(59, 130, 246, 0.08); }
.skeleton-bar:nth-child(4) { animation-delay: 0.45s; background: rgba(14, 165, 233, 0.08); }
.skeleton-bar:nth-child(5) { animation-delay: 0.6s; background: rgba(139, 92, 246, 0.08); }

.skeleton-axis {
  width: 100%;
  height: 1px;
  background: var(--da-border);
  opacity: 0.5;
}

@keyframes shimmer {
  0%, 100% { opacity: 0.3; transform: scaleY(0.98); }
  50% { opacity: 0.8; transform: scaleY(1); }
}
</style>
