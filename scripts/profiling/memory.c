/* macOS task accounting, sampled outside the measured Node/engine event loops.
 * Per-task footprints/RSS are not a deduplicated physical total after fork. */
#include <libproc.h>
#include <mach/mach_time.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
static volatile sig_atomic_t stop;
static void finish(int signal) { stop = 1; }
int main(int argc, char **argv)
{
  if (argc != 2) return 2;
  int group = atoi(argv[1]);
  // proc_pid_rusage CPU counters use Mach ticks, not nanoseconds.
  mach_timebase_info_data_t timebase; mach_timebase_info(&timebase);
  signal(SIGTERM, finish); signal(SIGINT, finish);
  while (!stop && kill(group, 0) == 0) {
    int pids[8192];
    int n = proc_listpids(PROC_PGRP_ONLY, group, pids, sizeof pids) / sizeof(int);
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    printf("{\"time\":%.3f,\"group\":%d,\"tasks\":[", t.tv_sec * 1000.0 + t.tv_nsec / 1e6, group);
    int count = 0;
    for (int i = 0; i < n; i++) {
      struct rusage_info_v4 usage;
      if (!pids[i] || proc_pid_rusage(pids[i], RUSAGE_INFO_V4, (rusage_info_t *)&usage)) continue;
      printf("%s{\"pid\":%d,\"rss\":%llu,\"footprint\":%llu,\"peakFootprint\":%llu,\"cpuNs\":%llu,\"cpuTicks\":%llu}", count++ ? "," : "", pids[i],
             usage.ri_resident_size, usage.ri_phys_footprint, usage.ri_lifetime_max_phys_footprint, (unsigned long long)((__uint128_t)(usage.ri_user_time + usage.ri_system_time) * timebase.numer / timebase.denom), usage.ri_user_time + usage.ri_system_time);
    }
    puts("]}"); fflush(stdout);
    struct timespec pause = {0, 50000000}; nanosleep(&pause, NULL);
  }
  return 0;
}
