export function getErrorMessage(error: unknown): string {
	if (error && typeof error === 'object' && 'message' in error
		&& typeof error.message === 'string' && error.message.trim()) return error.message;
	if (typeof error === 'string' && error.trim()) return error;
	return 'An unexpected error occurred. Please try again.';
}
