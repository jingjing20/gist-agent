export function cloneAnalysisActivity(activity) {
    return {
        ...activity,
        details: (Array.isArray(activity.details) ? activity.details : [])
            .filter((item) => item && typeof item === 'object')
            .map((item) => ({
                ...item,
                value: Array.isArray(item.value) ? [...item.value] : item.value,
            })),
        ...(Array.isArray(activity.qualityMessages) ? { qualityMessages: activity.qualityMessages.map((item) => ({ ...item })) } : {}),
        ...(activity.query ? { query: { ...activity.query } } : {}),
    };
}
