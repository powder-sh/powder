import { Skeleton, SkeletonList } from '@/components/ui/skeleton'

// Shown while a dashboard page's server render streams in (activity, settings)
// and while a client page's code loads, so the content area never blanks.
export default function DashboardLoading() {
	return (
		<div className="space-y-6">
			<div className="space-y-2">
				<Skeleton className="h-7 w-40" />
				<Skeleton className="h-3.5 w-72 max-w-full" />
			</div>
			<SkeletonList rows={5} />
		</div>
	)
}
