# The search paths (applied) and an engine setting (said, not applied).
use File::Basename qw(dirname);
use Cwd qw(abs_path);
my $root = dirname(abs_path(__FILE__));
ensure_path('TEXINPUTS', "$root/common/tex//");
$pdf_mode = 1;
