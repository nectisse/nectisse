import { useId } from 'react';
import type { PeopleScope } from '@/shared/lib/people-navigation';

/** 两类人物共用配色与尺寸，图案随入口变化。 */
export function PeopleArtwork({ scope }: { scope: PeopleScope }): React.JSX.Element {
	const gradient = useId();

	return (
		<svg className="people-artwork" data-scope={scope} viewBox="0 0 1200 240" preserveAspectRatio="xMaxYMid slice" aria-hidden="true" focusable="false">
			<defs>
				<linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
					<stop stopColor="var(--art-base)" />
					<stop offset="1" stopColor="var(--art-wash)" />
				</linearGradient>
			</defs>
			<path fill={`url(#${gradient})`} d="M0 0h1200v240H0z" />
			<path d="M0 220C180 125 300 270 505 173S840 128 1200 199v41H0Z" fill="var(--art-rose)" opacity=".18" />
			<path d="M140 240c230-130 330 0 510-64s300-48 550 12" fill="none" stroke="var(--art-paper)" strokeWidth="2" opacity=".5" />
			{scope === 'actors' ? (
				<>
					<circle cx="1000" cy="42" r="96" fill="var(--art-honey)" opacity=".65" />
					<path d="M635 192 1215 126v94l-580 66Z" fill="var(--art-ink)" opacity=".13" />
					<g fill="var(--art-paper)" opacity=".65">
						<path d="m660 201 24-3v12l-24 3Zm58-7 24-3v12l-24 3Zm58-7 24-3v12l-24 3Zm58-7 24-3v12l-24 3Zm58-7 24-3v12l-24 3Zm58-7 24-3v12l-24 3Zm58-7 24-3v12l-24 3Zm58-7 24-3v12l-24 3Zm58-7 24-3v12l-24 3Z" />
					</g>
					<g transform="translate(752 -8) rotate(-11 75 110)">
						<rect width="154" height="222" rx="5" fill="var(--art-paper)" />
						<path d="M10 10h134v178H10z" fill="var(--art-rose)" />
						<path d="M10 124c33-28 66-18 134-76v140H10Z" fill="var(--art-honey)" opacity=".6" />
						<path d="M25 188c4-47 22-71 52-71s47 24 52 71" fill="var(--art-ink)" opacity=".7" />
						<ellipse cx="77" cy="89" rx="29" ry="37" fill="var(--art-paper)" />
						<path d="M46 105V78c0-45 61-45 61 0v25c-9-10-16-26-20-42-11 20-24 31-41 44Z" fill="var(--art-ink)" />
						<path d="M14 204h73m12 0h32" stroke="var(--art-ink)" strokeWidth="3" opacity=".2" />
					</g>
					<g transform="translate(947 28) rotate(10 72 102)">
						<rect width="146" height="208" rx="5" fill="var(--art-paper)" />
						<path d="M10 10h126v164H10z" fill="var(--art-blue)" />
						<circle cx="112" cy="36" r="38" fill="var(--art-honey)" opacity=".8" />
						<path d="M20 174c9-44 25-63 54-63s45 19 52 63" fill="var(--art-paper)" opacity=".75" />
						<path d="M47 104V72c0-42 58-42 58 0v32Z" fill="var(--art-ink)" />
						<ellipse cx="76" cy="81" rx="23" ry="30" fill="var(--art-rose)" />
						<path d="M49 77c19-5 31-16 35-30l18 32V62L79 40 54 51Z" fill="var(--art-ink)" />
						<path d="M14 190h76" stroke="var(--art-ink)" strokeWidth="3" opacity=".2" />
					</g>
					<g fill="none" stroke="var(--art-paper)" strokeWidth="2" opacity=".7">
						<circle cx="1159" cy="192" r="56" />
						<circle cx="1159" cy="192" r="36" />
						<path d="M680 50v24m-12-12h24m428-31v18m-9-9h18" />
					</g>
				</>
			) : (
				<>
					<circle cx="1045" cy="42" r="103" fill="var(--art-honey)" opacity=".55" />
					<path d="M650 176c104-94 184 73 282-20s168-100 268-45" fill="none" stroke="var(--art-blue)" strokeWidth="47" opacity=".65" />
					<g transform="translate(755 17) rotate(-10 128 95)">
						<rect x="7" y="8" width="258" height="190" rx="6" fill="var(--art-ink)" opacity=".08" />
						<rect width="258" height="190" rx="4" fill="var(--art-paper)" />
						<path d="M27 38h90m-90 12h55" stroke="var(--art-ink)" strokeWidth="3" opacity=".22" />
						<path d="M24 143c27-70 59-71 83-20s53 32 70-12 41-37 57-18" fill="none" stroke="var(--art-rose)" strokeWidth="28" strokeLinecap="round" />
						<path d="M66 153c37-40 68-30 100-71" fill="none" stroke="var(--art-honey)" strokeWidth="20" strokeLinecap="round" opacity=".85" />
						<path d="M151 38h74m-55 12h55" stroke="var(--art-ink)" strokeWidth="2" opacity=".12" />
					</g>
					<g transform="translate(1037 48) rotate(17 60 90)">
						<path d="M7 4h127v163H7z" fill="var(--art-paper)" />
						<path d="M17 14h107v128H17z" fill="var(--art-blue)" />
						<circle cx="95" cy="45" r="19" fill="var(--art-honey)" />
						<path d="M17 105c35-39 50 13 107-17v54H17Z" fill="var(--art-ink)" opacity=".4" />
						<path d="M17 126c44-35 66 16 107-4v20H17Z" fill="var(--art-rose)" />
					</g>
					<g transform="translate(1004 170) rotate(-34)">
						<rect width="176" height="13" rx="4" fill="var(--art-ink)" opacity=".8" />
						<path d="m-25 6 25-6v13Z" fill="var(--art-paper)" />
						<path d="m-25 6 9-2v5Z" fill="var(--art-ink)" />
						<path d="M150 0v13" stroke="var(--art-honey)" strokeWidth="5" />
					</g>
					<path d="M691 44v24m-12-12h24m469 143v20m-10-10h20" fill="none" stroke="var(--art-paper)" strokeWidth="2" opacity=".8" />
				</>
			)}
		</svg>
	);
}
