// Crank-slider kinematics for Fig. 1 (Great Western 7 ft driving wheel).
export const rpmFor = (mph, wheelFt = 7) => mph * 5280 * 12 / (60 * Math.PI * wheelFt * 12);
export const pistonX = (theta, r, l) => r * Math.cos(theta) + Math.sqrt(l * l - r * r * Math.sin(theta) ** 2);
export const crankPin = (theta, r) => [r * Math.cos(theta), r * Math.sin(theta)];
