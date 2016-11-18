$("#clock").countdown("2019/05/10", function(event){
  var totalHours =  event.offset.totalDays * 24 + event.offset.hours;
  $(this).html(event.strftime(totalHours + "hr %M min %S sec"));
});
