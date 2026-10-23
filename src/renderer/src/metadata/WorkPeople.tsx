import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { MetadataRecord } from '../../../shared/metadata';

export function WorkPeople({ people, onPerformer }: { people: MetadataRecord['people']; onPerformer?: (name: string) => void }): React.JSX.Element {
	return (
		<ul className="live-people" aria-label="人物与角色">
			{people.map((person, index) => (
				<Badge asChild variant="outline" className="person-chip" key={`${person.role}-${index}`}>
					<li>
						<span className="person-name">{person.name}</span>
						<span className="person-role">{person.role === 'performer' ? '出演' : person.role === 'director' ? '导演' : '卖家'}</span>
						{person.role === 'performer' && onPerformer && (
							<Button
								variant="ghost"
								size="xs"
								className="performer-subscribe"
								aria-label={`${person.name}：订阅新作`}
								title={`订阅 ${person.name} 的新作`}
								onClick={() => onPerformer(person.name)}
							>
								订阅
							</Button>
						)}
					</li>
				</Badge>
			))}
		</ul>
	);
}
