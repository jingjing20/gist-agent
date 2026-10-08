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
import { BarChart, LineChart, PieChart, ScatterChart, RadarChart, FunnelChart } from 'echarts/charts';
import { TitleComponent, TooltipComponent, GridComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ChartData } from '../../types';

echarts.use([BarChart, LineChart, PieChart, ScatterChart, RadarChart, FunnelChart, TitleComponent, TooltipComponent, GridComponent, LegendComponent, CanvasRenderer]);

function themeColor(name: string, alpha = 1): string {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return alpha === 1 ? value : echarts.color.modifyAlpha(value, alpha);
}

const props = defineProps<{
    chartData?: ChartData;
}>();

const chartRef = ref<HTMLElement>();
const barHeights = ['60%', '85%', '45%', '70%', '55%'];
let chart: echarts.ECharts | null = null;
let themeObserver: MutationObserver | null = null;

function buildOption(data: ChartData): Record<string, unknown> {
    const COLORS = ['--status-info', '--da-gradient-start', '--da-gradient-end', '--status-success', '--status-warning', '--chart-pink', '--destructive'].map((name) => themeColor(name));
    const isPie = data.chartType === 'pie';
    const isFunnel = data.chartType === 'funnel';
    const isRadar = data.chartType === 'radar';

    const base: Record<string, unknown> = {
        title: {
            text: data.title,
            left: 'center',
            top: 10,
            textStyle: {
                color: themeColor('--da-text-main'), // da-text-main
                fontSize: 15,
                fontWeight: 600,
            },
        },
        tooltip: {
            trigger: isPie ? 'item' : 'axis',
            backgroundColor: themeColor('--da-panel'), // da-chart-bg / panel based
            borderColor: themeColor('--status-info'), // da-primary-alpha
            borderWidth: 1,
            textStyle: { color: themeColor('--da-text-main'), fontSize: 12 },
            padding: [10, 14],
            borderRadius: 8,
            shadowBlur: 10,
            shadowColor: themeColor('--shadow-color', 0.3),
        },
        color: COLORS,
    };

    if (isPie || isFunnel) {
        const chartData =
            data.series[0]?.data.map((val, i) => ({
                name: data.xAxis?.[i] ?? data.series[0]?.name ?? `${i}`,
                value: val,
            })) ?? [];

        if (isPie) {
            base.series = [
                {
                    type: 'pie',
                    radius: ['45%', '70%'],
                    center: ['50%', '55%'],
                    itemStyle: {
                        borderRadius: 8,
                        borderColor: themeColor('--da-chart-bg'), // da-chart-bg
                        borderWidth: 2,
                    },
                    label: { color: themeColor('--da-text-muted'), fontSize: 12 },
                    emphasis: {
                        label: { fontSize: 14, fontWeight: 'bold' },
                        itemStyle: {
                            shadowBlur: 15,
                            shadowColor: themeColor('--status-info'), // da-primary shadow
                        },
                    },
                    data: chartData,
                },
            ];
        } else {
            base.series = [
                {
                    type: 'funnel',
                    left: '10%',
                    width: '80%',
                    label: { color: themeColor('--da-text-muted'), fontSize: 12 },
                    itemStyle: {
                        borderColor: themeColor('--da-chart-bg'),
                        borderWidth: 2,
                    },
                    data: chartData,
                },
            ];
        }
        return base;
    }

    if (isRadar) {
        const indicators = (data.xAxis ?? []).map((name) => ({ name }));
        base.radar = {
            indicator: indicators,
            axisName: { color: themeColor('--da-text-muted'), padding: [3, 5] },
            splitLine: { lineStyle: { color: themeColor('--da-border') } },
            splitArea: { show: false },
            axisLine: { lineStyle: { color: themeColor('--da-border') } },
        };

        base.series = [
            {
                type: 'radar',
                symbol: 'circle',
                symbolSize: 6,
                lineStyle: { width: 2 },
                areaStyle: { opacity: 0.2 },
                data: data.series.map((s) => ({
                    name: s.name,
                    value: s.data,
                })),
            },
        ];

        if (data.series.length > 1) {
            base.legend = {
                top: 40,
                textStyle: { color: themeColor('--da-text-muted'), fontSize: 12 },
            };
        }
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
        axisLabel: { color: themeColor('--da-text-muted'), fontSize: 11, margin: 12 },
        axisLine: { lineStyle: { color: themeColor('--da-border') } }, // da-border
        axisTick: { show: false },
        splitLine: { show: false },
    };

    base.yAxis = {
        type: 'value',
        axisLabel: { color: themeColor('--da-text-muted'), fontSize: 11 },
        splitLine: {
            lineStyle: {
                color: themeColor('--da-border'), // da-border light alpha
                type: 'dashed',
            },
        },
    };

    if (data.series.length > 1) {
        base.legend = {
            top: 40,
            itemGap: 15,
            itemWidth: 10,
            itemHeight: 10,
            icon: 'circle',
            textStyle: { color: themeColor('--da-text-muted'), fontSize: 12 },
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
                    { offset: 0, color: echarts.color.modifyAlpha(COLORS[i % COLORS.length]!, 0.2) },
                    { offset: 1, color: echarts.color.modifyAlpha(COLORS[i % COLORS.length]!, 0) },
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
                    { offset: 1, color: echarts.color.modifyAlpha(COLORS[i % COLORS.length]!, 0.67) },
                ]),
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
    themeObserver = new MutationObserver(renderChart);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    renderChart();
    window.addEventListener('resize', handleResize);
});

watch(
    () => props.chartData,
    () => {
        nextTick(renderChart);
    },
    { deep: true }
);

onUnmounted(() => {
    themeObserver?.disconnect();
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
    box-shadow: 0 8px 32px color-mix(in srgb, var(--shadow-color) 20%, transparent);
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
    background: color-mix(in srgb, var(--status-info) 12%, transparent); /* da-primary alpha */
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
    background: color-mix(in srgb, var(--status-info) 8%, transparent); /* da-primary alpha */
    animation: shimmer 1.8s infinite ease-in-out;
}

.skeleton-bar:nth-child(2) {
    animation-delay: 0.15s;
    background: color-mix(in srgb, var(--da-gradient-start) 8%, transparent);
}
.skeleton-bar:nth-child(3) {
    animation-delay: 0.3s;
    background: color-mix(in srgb, var(--da-gradient-end) 8%, transparent);
}
.skeleton-bar:nth-child(4) {
    animation-delay: 0.45s;
    background: color-mix(in srgb, var(--status-info) 8%, transparent);
}
.skeleton-bar:nth-child(5) {
    animation-delay: 0.6s;
    background: color-mix(in srgb, var(--da-gradient-start) 8%, transparent);
}

.skeleton-axis {
    width: 100%;
    height: 1px;
    background: var(--da-border);
    opacity: 0.5;
}

@keyframes shimmer {
    0%,
    100% {
        opacity: 0.3;
        transform: scaleY(0.98);
    }
    50% {
        opacity: 0.8;
        transform: scaleY(1);
    }
}
</style>
