import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { clampCamera, homeCamera, WALL_MIN_SCALE, WALL_MAX_SCALE, type WallCamera, type WallSize } from '../model/wall-layout';

export function useWallCamera(extent: WallSize, scope: string, initial: WallCamera | undefined, remember: (camera: WallCamera) => void) {
	const viewport = useRef<HTMLDivElement>(null);
	const [element, setElement] = useState<HTMLDivElement | null>(null);
	const viewportRef = useCallback((node: HTMLDivElement | null): void => {
		viewport.current = node;
		setElement(node);
	}, []);
	const world = useRef<HTMLDivElement>(null);
	const current = useRef<WallCamera>(initial ?? homeCamera({ width: innerWidth, height: innerHeight }, extent));
	const atHome = useRef(!initial);
	const [view, setView] = useState({ camera: current.current, size: { width: innerWidth, height: innerHeight } });
	const bounds = useRef({ extent, size: view.size });
	bounds.current.extent = extent;
	const scopeRef = useRef(scope);
	const frame = useRef(0);
	const drag = useRef<{ id: number; x: number; y: number; origin: WallCamera; moved: boolean } | undefined>(undefined);
	const dragged = useRef(false);
	const remembered = useRef(remember);
	remembered.current = remember;

	const paint = (camera: WallCamera): void => {
		current.current = clampCamera(camera, bounds.current.size, bounds.current.extent);
		remembered.current(current.current);
		if (frame.current) {
			return;
		}
		frame.current = requestAnimationFrame(() => {
			frame.current = 0;
			const camera = current.current;
			if (world.current) {
				world.current.style.transform = `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})`;
			}
			setView((old) =>
				Math.abs(old.camera.x - camera.x) + Math.abs(old.camera.y - camera.y) > 60 || old.camera.scale !== camera.scale
					? { camera: { ...camera }, size: bounds.current.size }
					: old,
			);
		});
	};

	const zoom = (factor: number, x = bounds.current.size.width / 2, y = bounds.current.size.height / 2): void => {
		atHome.current = false;
		const old = current.current;
		const scale = Math.max(WALL_MIN_SCALE, Math.min(WALL_MAX_SCALE, old.scale * factor));
		paint({ scale, x: x - ((x - old.x) * scale) / old.scale, y: y - ((y - old.y) * scale) / old.scale });
	};

	useLayoutEffect(() => {
		const node = viewport.current;
		if (!node) {
			return;
		}
		const observer = new ResizeObserver(() => {
			bounds.current.size = { width: node.clientWidth, height: node.clientHeight };
			paint(atHome.current ? homeCamera(bounds.current.size, bounds.current.extent) : current.current);
			setView({ camera: { ...current.current }, size: bounds.current.size });
		});
		observer.observe(node);
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame.current);
			frame.current = 0;
		};
	}, [element]);

	useEffect(() => {
		if (scopeRef.current !== scope) {
			scopeRef.current = scope;
			atHome.current = true;
		}
		paint(atHome.current ? homeCamera(bounds.current.size, bounds.current.extent) : current.current);
	}, [extent.width, extent.height, scope]);

	useEffect(() => {
		const node = viewport.current;
		if (!node) {
			return;
		}
		const wheel = (event: WheelEvent): void => {
			event.preventDefault();
			if (event.ctrlKey || event.metaKey) {
				zoom(Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
			} else {
				atHome.current = false;
				const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1;
				paint({
					...current.current,
					x: current.current.x - (event.shiftKey ? event.deltaY : event.deltaX) * unit,
					y: current.current.y - (event.shiftKey ? 0 : event.deltaY) * unit,
				});
			}
		};
		node.addEventListener('wheel', wheel, { passive: false });
		return () => node.removeEventListener('wheel', wheel);
	}, [element]);

	return {
		viewport,
		viewportRef,
		world,
		view,
		zoom,
		reset: () => {
			atHome.current = true;
			paint(homeCamera(bounds.current.size, bounds.current.extent));
		},

		pan: (x: number, y: number) => {
			atHome.current = false;
			paint({ ...current.current, x: current.current.x + x, y: current.current.y + y });
		},

		handlers: {
			onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
				if (event.button === 0 && event.isPrimary) {
					dragged.current = false;
					drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: { ...current.current }, moved: false };
				}
			},
			onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
				const start = drag.current;
				if (!start || start.id !== event.pointerId) {
					return;
				}
				const x = event.clientX - start.x;
				const y = event.clientY - start.y;
				if (!start.moved && Math.hypot(x, y) < 6) {
					return;
				}
				if (!start.moved) {
					start.moved = true;
					event.currentTarget.setPointerCapture(event.pointerId);
				}
				dragged.current = true;
				atHome.current = false;
				paint({ ...start.origin, x: start.origin.x + x, y: start.origin.y + y });
			},
			onPointerUp: () => {
				drag.current = undefined;
			},
			onPointerCancel: () => {
				drag.current = undefined;
			},
			onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
				if (dragged.current && event.detail !== 0) {
					event.preventDefault();
					event.stopPropagation();
					dragged.current = false;
				}
			},
		},
	};
}
